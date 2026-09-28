// Role: loads a page in a hidden BrowserWindow to intercept .m3u8 / .mpd manifest
// URLs that are only reachable through JavaScript-based video players.

import log from 'electron-log';
import { resolveYtDlpCommand } from './binary-resolver';
import { getProbeStrategy } from './url-router';
import {
  SPOOF_UA,
  SUBTITLE_PATTERN,
  fetchWithDeadline,
  mediaTypeFromUrl,
  openHiddenProbe,
  removeTempFile,
  runInPage,
  runProbeChild,
  writeCookiesFile,
  type StreamType,
} from './probe-support';

export { sweepProbeTempFiles } from './probe-support';

/**
 * `--dump-json` for a single YouTube video is routinely several megabytes —
 * every format, every fragment list. The default 1MB stdout buffer aborted the
 * probe with ERR_CHILD_PROCESS_STDIO_MAXBUFFER before a line of it was parsed,
 * which is what silently cost the UI its title and thumbnail on YouTube.
 */
const PROBE_MAX_BUFFER = 64 * 1024 * 1024;

/** A full `--dump-json` can take a while; it can no longer take forever. */
const YTDLP_PROBE_TIMEOUT_MS = 60_000;

export interface StreamManifest {
  title: string;
  thumbnail?: string;
  duration?: number;
  formats: Array<{
    formatId: string;
    ext: string;
    resolution?: string;
    filesize?: number;
    url: string;
  }>;
}

export async function probeViaYtDlp(url: string, signal?: AbortSignal): Promise<StreamManifest> {
  const ytDlpCmd = resolveYtDlpCommand();
  // An argument array rather than a shell string: no quoting to get wrong, and
  // a URL containing shell metacharacters cannot be interpreted as anything but
  // an argument. `--` ends option parsing.
  const result = await runProbeChild(
    ytDlpCmd.command,
    // --no-playlist because this probe describes ONE media item. Without it a
    // URL carrying `list=` (every YouTube radio mix, every "watch later" link)
    // makes yt-dlp emit one JSON object per entry — for a radio mix, an
    // effectively endless stream of them that no buffer size can absorb.
    [...ytDlpCmd.args, '--dump-json', '--no-playlist', '--no-download', '--no-warnings', '--', url],
    { timeoutMs: YTDLP_PROBE_TIMEOUT_MS, signal, maxBytes: PROBE_MAX_BUFFER },
  );
  if (result.code !== 0) {
    throw new Error(`yt-dlp probe failed (exit ${result.code ?? 'none'}): ${result.stderr.trim().slice(-500)}`);
  }
  const data = JSON.parse(result.stdout);
  return {
    title: data.title,
    thumbnail: data.thumbnail,
    duration: data.duration,
    formats: (data.formats || []).map((f: YtDlpRawFormat) => ({
      formatId: f.format_id,
      ext: f.ext,
      resolution: f.resolution,
      filesize: f.filesize,
      url: f.url,
    })),
  };
}

/** Shape of one entry in yt-dlp's `--dump-json` "formats" array (only the fields we use). */
interface YtDlpRawFormat {
  format_id: string;
  ext: string;
  resolution?: string;
  filesize?: number;
  url: string;
}

/** A subtitle file the page's player requested while the stream loaded. */
export interface CapturedSubtitle {
  url: string;
  language?: string;
  label?: string;
  /** The referer the player sent; the subtitle host may insist on it. */
  referer?: string;
}

export interface ManifestResult {
  originalUrl: string;
  manifestUrl: string;
  type: StreamType;
  referer?: string;
  /** Path to a Netscape-format cookies.txt for this CDN domain, if available. */
  cookiesFile?: string;
  /**
   * What happened to the requested language, when one was requested.
   *
   * 'selected' — the requested server was clicked before this manifest was
   * accepted; 'absent' — the page offers no such language; 'unconfirmed' — the
   * selection could not be proven (it timed out or failed), so this manifest
   * may be the page's default. The gate used to log "taking the default
   * stream" and hand the manifest over as if it were the one asked for: 8 of
   * 10 Dub episodes in one real run, with nothing on the row to say so.
   */
  languageOutcome?: 'selected' | 'absent' | 'unconfirmed';
  /** The translation proven to be selected — set only with 'selected'. */
  translation?: string;
  /**
   * Subtitle tracks the player requested while the page loaded.
   *
   * anikoto's Sub stream carries its English subtitles as a separate .vtt the
   * player fetches next to the manifest (measured: the .vtt request lands
   * ~100ms before master.m3u8). yt-dlp is handed only the manifest, so every
   * Sub episode used to arrive as Japanese audio with no subtitles at all.
   */
  subtitles?: CapturedSubtitle[];
}

export interface ApiProbeResult {
  url: string;
  referer?: string;
  /** Path to a Netscape-format cookies.txt written from the embed-page response cookies. */
  cookiesFile?: string;
}

/** Known API domains whose JSON responses often contain manifest URLs. */
const API_DOMAINS = ['anikotoapi.site', 'anikotoapi.com', 'nekostream.site'];

/** Known video CDNs that host HLS/DASH manifests for anime sites. */
const KNOWN_CDNS = [
  's2.cinewave2.site',
  'cinewave2.site',
  'megaplay.buzz',
  'gogocdn.net',
  'mp4upload.com',
  'filemoon.sx',
  'vizcloud.online',
  'rapid-cloud.co',
];

function isPlayableUrl(url: string): boolean {
  return Boolean(mediaTypeFromUrl(url)) || KNOWN_CDNS.some((cdn) => url.includes(cdn));
}

/** What a network request is, as far as the gate is concerned. */
function streamTypeOf(url: string): StreamType | null {
  const type = mediaTypeFromUrl(url);
  if (type) return type;
  // Known CDNs sometimes serve HLS from an extension-less `/hls/` path.
  return KNOWN_CDNS.some((cdn) => url.includes(cdn)) && url.includes('/hls/') ? 'm3u8' : null;
}

/**
 * Timeout in milliseconds for manifest discovery. If no manifest is found
 * within this window the promise resolves with `null`.
 */
const EXTRACTION_TIMEOUT_MS = 45_000;
/** Ceiling on the last-resort JS read, which can hang with a stuck renderer. */
const JS_LAST_RESORT_MS = 5_000;
/** Ceiling on a single raw fetch, so a silent server cannot stall the queue. */
const FETCH_TIMEOUT_MS = 20_000;
/** How long to wait for a page's language switcher to render. */
const LANGUAGE_WAIT_MS = 8_000;

/**
 * How long to wait after page load before triggering a reload retry
 * (in case the page uses delayed JS initialization).
 */
const POST_LOAD_WAIT_MS = 10_000;

/** Pause before re-trying a main-frame load that failed on the network. */
const NETWORK_RETRY_DELAY_MS = 2_000;

/**
 * Main-frame load failures worth one more attempt: DNS, a dropped or reset
 * connection, a network change. ERR_ABORTED (-3) is deliberately absent — it
 * means a newer navigation replaced this one, which is already loading.
 */
const RETRYABLE_LOAD_ERRORS = new Set([-2, -7, -21, -100, -101, -105, -106, -118]);

/**
 * JavaScript snippet injected after page load to extract manifest URLs from
 * the page context (video elements, script configs, global variables).
 */
const EXTRACT_JS = `
(() => {
  const results = [];

  // 1. Check all <source> and <video> elements
  document.querySelectorAll('video, source, iframe, embed').forEach(el => {
    const src = el.src || el.getAttribute('src') || el.getAttribute('data-src') || '';
    if (src && /m3u8|mpd|hls|dash/i.test(src)) results.push(src);
  });

  // 2. Check for video.js / hls.js / dash.js instances
  if (typeof videojs !== 'undefined') {
    try {
      const player = videojs();
      if (player && player.src) {
        const src = player.src();
        if (src && /m3u8|mpd/i.test(src)) results.push(src);
      }
    } catch {}
  }

  // 3. Check window.__NEXT_DATA__ or similar JSON config blobs
  const script = document.getElementById('__NEXT_DATA__') || document.querySelector('script[type="application/json"]');
  if (script) {
    try {
      const json = JSON.parse(script.textContent || '{}');
      const str = JSON.stringify(json);
      const m = str.match(/(https?:\\/\\/[^"'\\s,\\]]+?\\.(m3u8|mpd)[^"'\\s]*)/i);
      if (m) results.push(m[1]);
    } catch {}
  }

  // 4. Scan ALL script contents for manifest URLs
  document.querySelectorAll('script').forEach(s => {
    const text = s.textContent || '';
    const matches = text.matchAll(/(https?:\\/\\/[^"'\\s<>]+?\\.(?:m3u8|mpd)[^"'\\s<>]*)/gi);
    for (const match of matches) results.push(match[1]);
  });

  // 5. Check global HLS.js / dash.js instances
  const win = window;
  if (typeof Hls !== 'undefined' && win.hls && win.hls.url) results.push(win.hls.url);
  if (typeof dashjs !== 'undefined') {
    try {
      const ctx = dashjs.MediaPlayer().getDebug();
      if (ctx && ctx.url) results.push(ctx.url);
    } catch {}
  }

  // 6. Walk ALL enumerable window properties for manifest-like URLs
  const visited = new Set();
  const walk = (obj, depth = 0) => {
    if (depth > 3 || !obj || typeof obj !== 'object' || visited.has(obj)) return;
    visited.add(obj);
    for (const key of Object.getOwnPropertyNames(obj)) {
      try {
        const val = obj[key];
        if (typeof val === 'string' && /https?:\\/\\/[^"'\\s]+?(m3u8|mpd)/i.test(val)) results.push(val);
        if (typeof val === 'object' && val) walk(val, depth + 1);
      } catch {}
    }
  };
  walk(win);

  // 7. Check all elements' dataset/attributes for player configs
  document.querySelectorAll('[data-player], [data-config], [data-video], [data-source], [data-manifest]').forEach(el => {
    for (const attr of ['data-player', 'data-config', 'data-video', 'data-source', 'data-manifest', 'data-hls', 'data-url']) {
      const val = el.getAttribute(attr);
      if (val && /m3u8|mpd|https?:\\/\\//i.test(val)) results.push(val);
    }
  });

  // 8. Check element attributes that might contain URLs
  document.querySelectorAll('[href], [src]').forEach(el => {
    const href = el.getAttribute('href') || '';
    const src = el.getAttribute('src') || '';
    if (/m3u8|mpd/i.test(href)) results.push(href);
    if (/m3u8|mpd/i.test(src)) results.push(src);
  });

  return [...new Set(results)];
})();
`;

/**
 * Start the page's player: click play buttons and player containers, and
 * force-play any paused <video>, every 500ms for 20s.
 *
 * With a language requested it leaves anything inside a `[data-type]`
 * container alone. Those are the language servers; `button` matches a server
 * rendered as a <button>, and forty rounds of clicking every one of them ends
 * on whichever came last — usually not the language that was asked for.
 * (anikoto renders its servers as <li>, which none of these selectors match —
 * checked against the live page — so this guards the other shape.)
 */
function autoClickScript(sparesLanguageControls: boolean): string {
  return `
    (() => {
      const spare = ${sparesLanguageControls};
      const tryClick = (sel) => {
        document.querySelectorAll(sel).forEach(el => {
          if (spare && el.closest && el.closest('[data-type]')) return;
          if (el && typeof el.click === 'function') {
            try { el.click(); } catch {}
          }
        });
      };

      window.__sd_clicks = window.__sd_clicks || 0;
      const clickInterval = setInterval(() => {
        if (window.__sd_clicks++ > 40) {
          clearInterval(clickInterval);
          return;
        }
        // Generic play buttons
        tryClick('button, .play, .vjs-big-play-button, .jw-video, .plyr__control--overlaid');
        tryClick('[class*="play"], [class*="Play"], [id*="play"], [id*="Play"]');
        tryClick('[class*="player"], [class*="Player"], [class*="video"], [class*="Video"]');

        // Force-play any paused <video>
        document.querySelectorAll('video').forEach(v => {
          if (v.paused) v.play().catch(() => {});
          // Set source again as a fallback
          const src = v.getAttribute('data-src') || v.getAttribute('data-url');
          if (src && !v.src.includes(src)) { v.src = src; v.play().catch(() => {}); }
        });

        // Look for iframes and click inside them
        document.querySelectorAll('iframe').forEach(iframe => {
          try {
            const doc = iframe.contentDocument || iframe.contentWindow?.document;
            if (doc) {
              doc.querySelectorAll('button, video').forEach(el => {
                if (typeof el.click === 'function') el.click();
                if (el.tagName === 'VIDEO' && el.paused) el.play().catch(() => {});
              });
            }
          } catch {}
        });
      }, 500);

      // Scroll to trigger lazy-loaded content
      window.scrollTo({ top: document.body.scrollHeight * 0.4, behavior: 'instant' });
      setTimeout(() => window.scrollTo({ top: 0, behavior: 'instant' }), 1500);
    })();
  `;
}

interface ApiScan {
  manifestUrl: string | null;
  subtitles: string[];
}

/** Fetch a URL from the main process and parse its body for manifest URLs. */
async function fetchAndFindManifest(pageUrl: string, apiUrl: string, signal?: AbortSignal): Promise<ApiScan> {
  const { body } = await fetchWithDeadline(apiUrl, {
    headers: { Referer: pageUrl, Accept: 'application/json, text/plain, */*' },
    timeoutMs: FETCH_TIMEOUT_MS,
    signal,
  });
  const scan: ApiScan = { manifestUrl: null, subtitles: [] };
  if (!body?.trim()) return scan;

  // Try parsing as JSON and extract any URL-like string values. A player's
  // sources JSON lists its subtitle `tracks` beside the stream, so .vtt/.srt
  // files are collected on the same walk.
  try {
    const walk = (obj: unknown, depth = 0): void => {
      if (depth > 5) return;
      if (typeof obj === 'string') {
        if (!obj.startsWith('http')) return;
        if (SUBTITLE_PATTERN.test(obj)) scan.subtitles.push(obj);
        else if (!scan.manifestUrl && isPlayableUrl(obj)) scan.manifestUrl = obj;
      } else if (Array.isArray(obj)) {
        obj.forEach((v) => walk(v, depth + 1));
      } else if (obj && typeof obj === 'object') {
        for (const val of Object.values(obj as Record<string, unknown>)) walk(val, depth + 1);
      }
    };
    walk(JSON.parse(body));
  } catch { /* not JSON, fall through */ }

  if (!scan.manifestUrl) {
    // Fallback: regex search for .m3u8 / .mpd URLs
    const m = body.match(/(https?:\/\/[^\s"'<>",}]+?\.(?:m3u8|mpd|mp4)[^\s"'<>",}]*)/i);
    if (m) scan.manifestUrl = m[1];
  }
  return scan;
}

/**
 * Extract the episode number from an anikoto.cz watch URL.
 * Pattern: /watch/{slug}/{type?}/ep-{num}
 */
function extractEpisodeNumber(url: string): number | null {
  const m = url.match(/\/ep-(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Try to extract a video / manifest URL directly from the backend API that
 * anikoto.cz uses. This avoids the BrowserWindow (and reCAPTCHA) entirely.
 */
async function tryAnikotoApi(pageUrl: string, signal?: AbortSignal): Promise<ApiProbeResult | null> {
  // --- Step 1: Fetch the page HTML AND capture cookies ---
  const { body: pageHtml, setCookies: pageCookies } = await fetchWithDeadline(pageUrl, {
    headers: { Referer: 'https://anikoto.cz/' },
    timeoutMs: FETCH_TIMEOUT_MS,
    signal,
  });
  if (!pageHtml) {
    log.warn('[manifest-extractor] anikoto: failed to fetch page');
    return null;
  }

  // Robustly extract episodeListUrl from ANY script or variable
  let epListMatch: (RegExpMatchArray | Array<string | null> | null) =
    pageHtml.match(/episodeListUrl\s*[:=]\s*['"]([^'"]+)['"]/i) ||
    pageHtml.match(/["']url["']\s*[:=]\s*['"]([^'"]+episode[^'"]+)['"]/i);

  if (!epListMatch) {
    log.warn('[manifest-extractor] anikoto: episode list URL not found, scanning for backup patterns...');
    // Fallback 1: try to find any URL that looks like an API call for episodes
    const backupMatch = pageHtml.match(/https?:\/\/[^"'\s]+?\/api\/[^"'\s]+?episode[^"'\s]*/i);
    if (backupMatch) {
      epListMatch = [null, backupMatch[0]];
    } else {
      // Fallback 2: Brute force search for any JSON in <script> tags that has a .cz or .site URL
      const scripts = pageHtml.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) || [];
      for (const s of scripts) {
        const m = s.match(/https?:\/\/[^"'\s]+?episode[^"'\s]*/i);
        if (m) { epListMatch = [null, m[0]]; break; }
      }
    }
  }

  if (!epListMatch) return null;

  const epListUrl = epListMatch[1]!.replace(/&amp;/g, '&');
  log.info(`[manifest-extractor] anikoto: using episode list URL: ${epListUrl}`);

  // --- Step 2: Fetch the episode list AND capture cookies ---
  const { body: epListHtml, setCookies: epListCookies } = await fetchWithDeadline(epListUrl, {
    headers: { Referer: pageUrl },
    timeoutMs: FETCH_TIMEOUT_MS,
    signal,
  });
  if (!epListHtml) return null;

  // --- Step 3: Find the active episode ---
  const episodeNum = extractEpisodeNumber(pageUrl);
  if (!episodeNum) return null;

  // Use a non-linear search for attributes within LI tags
  const liPattern = /<li\s+([^>]+)>/gi;
  let match;
  while ((match = liPattern.exec(epListHtml)) !== null) {
    const attrs = match[1];
    if (attrs.includes(`data-ep-id="${episodeNum}"`) || attrs.includes(`data-ep-id='${episodeNum}'`)) {
      const malId = attrs.match(/data-mal=["'](\d+)["']/i)?.[1];
      const epSlug = attrs.match(/data-slug=["']([^"']+)["']/i)?.[1];
      const timestamp = attrs.match(/data-timestamp=["']([^"']+)["']/i)?.[1];

      // Combine cookies from all steps
      const allCookies = [...pageCookies, ...epListCookies];
      if (malId && epSlug) {
        log.info(`[manifest-extractor] anikoto: found mal=${malId}, slug=${epSlug}, ts=${timestamp || '0'}`);
        return fetchMapperApi(pageUrl, malId, epSlug, timestamp || '0', allCookies, signal);
      }
    }
  }

  log.warn(`[manifest-extractor] anikoto: episode ${episodeNum} not found in list HTML`);
  return null;
}

/**
 * Call the mapper.nekostream.site API to get the server embed URL for an episode.
 */
async function fetchMapperApi(
  pageUrl: string,
  malId: string,
  epSlug: string,
  timestamp: string,
  incomingCookies: string[],
  signal?: AbortSignal,
): Promise<ApiProbeResult | null> {
  const mapperUrl = `https://mapper.nekostream.site/api/mal/${malId}/${epSlug}/${timestamp}`;
  const { body: json, setCookies: mapperCookies } = await fetchWithDeadline(mapperUrl, {
    headers: { Referer: pageUrl, Accept: 'application/json, text/plain, */*' },
    timeoutMs: FETCH_TIMEOUT_MS,
    signal,
  });
  if (!json) return null;

  // Combine incoming cookies with mapper API cookies
  const allCookies = [...incomingCookies, ...mapperCookies];

  try {
    const data = JSON.parse(json);
    // Recursive search for anything that looks like a playable URL
    let foundUrl: string | null = null;

    const findMedia = (obj: unknown): void => {
      if (!obj || foundUrl) return;
      if (typeof obj === 'string') {
        if (/m3u8|mpd|mp4/i.test(obj) && obj.startsWith('http')) {
          foundUrl = obj;
        }
        return;
      }
      if (Array.isArray(obj)) {
        obj.forEach(findMedia);
        return;
      }
      if (typeof obj === 'object') {
        const record = obj as Record<string, unknown>;
        // Prioritize known keys
        for (const key of ['url', 'file', 'src', 'data', 'link']) {
          const val = record[key];
          if (typeof val === 'string' && val.startsWith('http') && /m3u8|mpd|mp4/i.test(val)) {
            foundUrl = val;
            return;
          }
        }
        Object.values(record).forEach(findMedia);
      }
    };

    findMedia(data);
    if (!foundUrl) return null;
    const mediaUrl: string = foundUrl;

    log.info(`[manifest-extractor] anikoto: found media URL via API: ${mediaUrl}`);
    // If it's an embed page, resolve it
    if (!mediaTypeFromUrl(mediaUrl) && !KNOWN_CDNS.some((c) => mediaUrl.includes(c))) {
      const resolved = await tryResolveEmbedUrl(mediaUrl, 'https://anikoto.cz/', allCookies, signal);
      if (!resolved) return null;
      try {
        return { url: resolved.url, referer: new URL(mediaUrl).origin + '/', cookiesFile: resolved.cookiesFile };
      } catch {
        return { url: resolved.url, referer: mediaUrl, cookiesFile: resolved.cookiesFile };
      }
    }
    // For direct manifest URLs, pass the accumulated cookies
    return { url: mediaUrl, referer: 'https://anikoto.cz/', cookiesFile: writeCookiesFile(allCookies, pageUrl) };
  } catch {
    return null;
  }
}

/**
 * Fetch an embed page (e.g. from megaplay.buzz) and scan its HTML for the
 * actual .m3u8 CDN URL. This handles the case where the mapper API returns
 * a player page URL instead of a direct manifest.
 */
async function tryResolveEmbedUrl(
  embedUrl: string,
  referer: string,
  incomingCookies: string[],
  signal?: AbortSignal,
): Promise<{ url: string; cookiesFile?: string } | null> {
  // Space out back-to-back requests to the embed CDN.
  await new Promise(resolve => setTimeout(resolve, 500));

  // Set-Cookie headers from the embed CDN are exported to yt-dlp below.
  const { body: html, setCookies } = await fetchWithDeadline(embedUrl, {
    headers: { Referer: referer },
    timeoutMs: FETCH_TIMEOUT_MS,
    signal,
  });
  if (!html) return null;

  let manifestUrl: string | null = null;

  // Look for .m3u8 URLs anywhere in the page
  const m3u8Match = html.match(/(https?:\/\/[^"'\s<>,\]]+?\.m3u8[^"'\s<>,\]]*)/i);
  if (m3u8Match) {
    log.info(`[manifest-extractor] Found CDN URL in embed page: ${m3u8Match[1]}`);
    manifestUrl = m3u8Match[1];
  }

  // Look for player config with source URL (common pattern: file:"..." or src:"...")
  if (!manifestUrl) {
    const srcMatch = html.match(/["'](?:file|src|url|source)["']\s*[:=]\s*["']([^"']+)["']/i);
    if (srcMatch && /m3u8|mp4|https?:/.test(srcMatch[1])) {
      log.info(`[manifest-extractor] Found source URL in embed config: ${srcMatch[1]}`);
      manifestUrl = srcMatch[1];
    }
  }

  // Look for playlist URL patterns
  if (!manifestUrl) {
    const playlistMatch = html.match(/(https?:\/\/[^"'\s<>,\]]+?\/playlist[^"'\s<>,\]]*)/i);
    if (playlistMatch) {
      log.info(`[manifest-extractor] Found playlist URL in embed page: ${playlistMatch[1]}`);
      manifestUrl = playlistMatch[1];
    }
  }

  if (!manifestUrl) {
    log.info('[manifest-extractor] No manifest found in embed page');
    return null;
  }

  // Export combined cookies (from anikoto + embed CDN) so yt-dlp can
  // present them when it fetches the manifest segments.
  return { url: manifestUrl, cookiesFile: writeCookiesFile([...incomingCookies, ...setCookies], embedUrl) };
}

/**
 * Try to resolve a manifest URL via direct HTTP API calls instead of a
 * BrowserWindow. Handles known API-based sites like anikoto.cz.
 */
async function tryApiProbe(pageUrl: string, signal?: AbortSignal): Promise<ApiProbeResult | null> {
  try {
    const host = new URL(pageUrl).hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'anikoto.cz') return await tryAnikotoApi(pageUrl, signal);
    return null;
  } catch { return null; }
}

/**
 * Pick a language on a page that serves each one as its own stream.
 *
 * anikoto renders `<div class="type" data-type="sub"><label>SUB</label><ul>…`
 * with the clickable servers inside; the container itself does nothing. The
 * list is rendered by page JS, so this polls for it rather than assuming it
 * exists at dom-ready.
 *
 * Returns 'clicked' when a server for the wanted language was activated,
 * 'absent' when the page offers no such language. Never rejects.
 */
function languageClickScript(translation: string): string {
  const selector = `[data-type="${translation}"] li, [data-type="${translation}"] button`;
  return `
    new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        try {
          const items = document.querySelectorAll(${JSON.stringify(selector)});
          if (items.length) {
            let idx = 0;
            items.forEach((el, i) => {
              if (el.classList && el.classList.contains('active')) idx = i;
            });
            try { items[idx].click(); } catch (e) { /* not clickable */ }
            resolve('clicked');
            return;
          }
        } catch (e) { /* selector unusable on this page */ }
        if (Date.now() - started > ${LANGUAGE_WAIT_MS}) { resolve('absent'); return; }
        setTimeout(tick, 250);
      };
      tick();
    })
  `;
}

/**
 * The referer the manifest's CDN will expect.
 *
 * Every interception site used to return the page URL the user pasted, and the
 * engine handed that to yt-dlp. The manifest is requested by the *player*,
 * which lives on a different origin, and anikoto's CDN serves it only to that
 * origin — the page URL gets a flat 403. Measured against the live CDN:
 * `Referer: https://megaplay.buzz/` returns 200 while the anikoto page URL, the
 * CDN's own origin and an unrelated referer all return 403.
 *
 * Chromium's default referrer policy sends the bare origin cross-origin, which
 * is exactly the form the CDN wants. Reading it from the intercepted request
 * keeps this correct for any host instead of hardcoding one embed provider —
 * anikoto has already moved from megaplay to vidtube once.
 */
function refererForRequest(
  details: { referrer?: string; frame?: { url?: string } | null },
  pageUrl: string,
): string {
  const referrer = details.referrer?.trim();
  if (referrer) return referrer;
  try {
    const frameUrl = details.frame?.url;
    if (frameUrl) return new URL(frameUrl).origin + '/';
  } catch {
    // Frame already navigated or destroyed — fall through to the page URL.
  }
  return pageUrl;
}

export async function extractManifest(
  pageUrl: string,
  wantedTranslation?: string,
  signal?: AbortSignal,
): Promise<ManifestResult | null> {
  if (signal?.aborted) return null;
  const wantsLanguage = Boolean(wantedTranslation) && wantedTranslation !== 'unknown';
  if (getProbeStrategy(pageUrl) === 'ytdlp') {
    try {
      log.info(`[manifest-extractor] Routing to yt-dlp probe: ${pageUrl}`);
      const manifest = await probeViaYtDlp(pageUrl, signal);
      const hlsFormat = manifest.formats.find(f => f.ext === 'mp4' && f.url.includes('m3u8'))
                     || manifest.formats.find(f => f.url.includes('m3u8') || f.url.includes('mpd'));
      if (hlsFormat) {
        const type = hlsFormat.url.includes('mpd') ? 'mpd' : 'm3u8';
        return { originalUrl: pageUrl, manifestUrl: hlsFormat.url, type, referer: pageUrl };
      }
      return null;
    } catch (e) {
      if (!signal?.aborted) log.warn(`[manifest-extractor] yt-dlp probe failed: ${e}`);
      return null;
    }
  }

  // --- Fast-path: try direct API probe first (avoids BrowserWindow) ---
  // Skipped when a language is requested: the API path returns whichever
  // stream the mapper hands back and cannot select sub or dub, so its answer
  // would arrive unproven every time.
  const apiResult = wantsLanguage ? null : await tryApiProbe(pageUrl, signal);
  if (signal?.aborted) {
    removeTempFile(apiResult?.cookiesFile);
    return null;
  }
  if (apiResult) {
    const type = mediaTypeFromUrl(apiResult.url) || 'm3u8';
    log.info(`[manifest-extractor] Returning URL from direct API probe: ${apiResult.url}`);
    return { originalUrl: pageUrl, manifestUrl: apiResult.url, type, referer: apiResult.referer, cookiesFile: apiResult.cookiesFile };
  }

  // --- Fall back to hidden BrowserWindow for JavaScript-rendered video players ---
  return probePage(pageUrl, wantedTranslation, signal);
}

/**
 * Loads `pageUrl` in an off-screen BrowserWindow, intercepts every network
 * request, and returns the first `.m3u8` or `.mpd` manifest the player asks
 * for. An `.mp4` is kept only as a last resort, because that is also what an
 * ad creative looks like.
 *
 * If the page settles without a manifest it is reloaded once (some sites need
 * a second pass to initialise their player). Resolves `null` when nothing is
 * found before the deadline, or at once when `signal` aborts.
 */
function probePage(
  pageUrl: string,
  wantedTranslation: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ManifestResult | null> {
  const { win, session: probeSession, dispose } = openHiddenProbe();

  return new Promise<ManifestResult | null>((resolve) => {
    let settled = false;
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let languageBail: ReturnType<typeof setTimeout> | undefined;
    // One extra load per probe, whether it is the settle-and-reload retry or a
    // retry after a network failure.
    let reloadsLeft = 1;
    let languageOutcome: ManifestResult['languageOutcome'];
    // An .mp4 seen on the wire: used only if no real manifest ever shows up.
    let mp4Fallback: ManifestResult | null = null;
    const subtitles = new Map<string, CapturedSubtitle>();

    // When a language is requested, the manifest the page loads on its own is
    // the wrong one — anikoto opens on SUB. Manifests are ignored until the
    // requested server has been clicked, so a dub download does not silently
    // capture the sub stream. With no language requested this is true from the
    // start and nothing changes.
    const wantsLanguage = Boolean(wantedTranslation) && wantedTranslation !== 'unknown';
    let languageReady = !wantsLanguage;
    // Bumped by every main-frame document, so an answer from a page that has
    // since been replaced cannot open the gate on its successor.
    let documentGeneration = 0;

    const finish = (result: ManifestResult | null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(deadline);
      clearTimeout(reloadTimer);
      clearTimeout(retryTimer);
      clearTimeout(languageBail);
      dispose();
      if (result && subtitles.size > 0) result = { ...result, subtitles: [...subtitles.values()] };
      if (result && wantsLanguage) {
        const outcome = languageOutcome ?? 'unconfirmed';
        result = {
          ...result,
          languageOutcome: outcome,
          translation: outcome === 'selected' ? wantedTranslation : undefined,
        };
      }
      resolve(result);
    };
    // Paused or cancelled by the engine: stop now rather than run to the
    // timeout with a hidden Chromium renderer nobody is waiting for.
    const onAbort = () => finish(null);
    signal?.addEventListener('abort', onAbort, { once: true });

    /** A manifest turned up. Streams win at once; an .mp4 waits in reserve. */
    const accept = (found: ManifestResult, how: string): void => {
      if (settled) return;
      if (found.type === 'mp4') {
        if (!mp4Fallback) {
          mp4Fallback = found;
          log.info(`[manifest-extractor] Holding ${found.manifestUrl} in reserve: an .mp4 may be an ad`);
        }
        return;
      }
      log.info(`[manifest-extractor] Found ${found.type} manifest${how}: ${found.manifestUrl}`);
      finish(found);
    };
    const giveUp = (why: string): void => {
      if (settled) return;
      if (mp4Fallback) log.info(`[manifest-extractor] No stream manifest (${why}); using the .mp4 seen on the page`);
      else log.warn(`[manifest-extractor] ${why} for ${pageUrl}`);
      finish(mp4Fallback);
    };

    /** Manifests the page's own JS context exposes. Gated like the network. */
    const readPageContext = (how: string): Promise<void> =>
      runInPage<string[]>(win, EXTRACT_JS).then((urls) => {
        if (settled || !languageReady || !Array.isArray(urls)) return;
        for (const u of urls) {
          const type = mediaTypeFromUrl(u);
          if (type) accept({ originalUrl: pageUrl, manifestUrl: u, type, referer: pageUrl }, how);
          if (settled) return;
        }
      });

    const deadline = setTimeout(() => {
      if (settled) return;

      // Before giving up, try JS context extraction as a last resort — but on a
      // deadline of its own. `executeJavaScript` never settles when the
      // renderer is hung: neither `.then` nor `.catch` runs, so the timeout
      // meant to rescue the extraction hung inside it instead, silently and
      // with no log line. The queue is serialised, so one such hang stalls
      // every remaining episode indefinitely — observed as a download stuck on
      // "starting" with nothing after `Probing …` in the log.
      const why = `Timed out after ${EXTRACTION_TIMEOUT_MS}ms`;
      const lastResort = setTimeout(() => giveUp(`${why} (JS context read never returned)`), JS_LAST_RESORT_MS);
      readPageContext(' via JS context')
        .catch(() => { /* reported below */ })
        .finally(() => {
          clearTimeout(lastResort);
          giveUp(`${why} (no manifest in JS context)`);
        });
    }, EXTRACTION_TIMEOUT_MS);

    const startAutoClick = (): void => {
      runInPage(win, autoClickScript(wantsLanguage)).catch(() => { });
    };

    /**
     * Close the gate for a new document and select the language on it.
     *
     * This used to run once, on the first dom-ready, and the gate was never
     * closed again. After any reload — the settle-and-retry below, a retry
     * after a network failure — the page came back on its default SUB server
     * with the gate still open and the earlier "selected" still recorded, so
     * the Sub stream was returned as proven Dub. Isaac's log for ep 560 shows
     * exactly that order: "server selected", then a reload, then a manifest.
     */
    const armLanguageGate = (): void => {
      const generation = ++documentGeneration;
      languageReady = false;
      languageOutcome = undefined;
      mp4Fallback = null;
      subtitles.clear();
      clearTimeout(languageBail);

      // Bounded like every other await in this file: a hung renderer must not
      // leave the gate closed forever, or no manifest is ever accepted.
      let answered = false;
      const open = (outcome: NonNullable<ManifestResult['languageOutcome']>, why: string): void => {
        if (answered || settled || generation !== documentGeneration) return;
        answered = true;
        clearTimeout(languageBail);
        languageReady = true;
        languageOutcome = outcome;
        log.info(`[manifest-extractor] Language "${wantedTranslation}": ${why}`);
        // Only now start the player: clicking play first would start the
        // default server's stream before the requested one was chosen.
        startAutoClick();
      };
      languageBail = setTimeout(() => open('unconfirmed', 'selection timed out; the manifest captured next is unproven'), LANGUAGE_WAIT_MS + 4_000);
      runInPage<string>(win, languageClickScript(String(wantedTranslation)))
        .then((outcome) => {
          if (outcome === 'clicked') open('selected', 'server selected');
          else open('absent', 'not offered by this page');
        })
        .catch(() => open('unconfirmed', 'selection failed; the manifest captured next is unproven'));
    };

    // dom-ready fires once per main-frame document, including after a reload.
    win.webContents.on('dom-ready', () => {
      if (settled) return;
      if (wantsLanguage) armLanguageGate();
      else startAutoClick();
    });

    let apiFetchAttempted = false;

    probeSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      if (settled) { callback({ cancel: true }); return; }
      try {
        const match = streamTypeOf(details.url);
        if (match && !languageReady) {
          // The default-language stream, arriving before the switch. Let it
          // through so the player keeps working, but do not capture it.
          callback({});
          return;
        }
        if (languageReady && SUBTITLE_PATTERN.test(details.url)) {
          // ponytail: only tracks requested before the manifest are caught
          // (anikoto asks ~100ms earlier); a grace window after the manifest
          // is the upgrade if a player orders them the other way.
          subtitles.set(details.url, { url: details.url, referer: refererForRequest(details, pageUrl) });
        }
        if (match === 'm3u8' || match === 'mpd') {
          // Cancel the request to avoid letting the player consume it
          callback({ cancel: true });
          accept({ originalUrl: pageUrl, manifestUrl: details.url, type: match, referer: refererForRequest(details, pageUrl) }, '');
          return;
        }
        if (match === 'mp4') {
          accept({ originalUrl: pageUrl, manifestUrl: details.url, type: 'mp4', referer: refererForRequest(details, pageUrl) }, '');
        }
      } catch {
        // swallow: this handler must never throw and block navigation
      }
      callback({});
    });

    // Ensure outgoing headers include Accept-Language / User-Agent
    probeSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
      const headers = { ...details.requestHeaders } as Record<string, string>;
      if (!headers['Accept-Language'] && !headers['accept-language']) headers['Accept-Language'] = 'en-US,en;q=0.9';
      if (!headers['User-Agent'] && !headers['user-agent']) headers['User-Agent'] = SPOOF_UA;
      callback({ requestHeaders: headers });
    });

    // Some sites answer an API call with JSON that names the manifest. The
    // response body cannot be read from here, so it is fetched again from the
    // main process. (A `filterResponseData` branch used to sit in front of
    // this; it is not an Electron API, so it threw every time and this
    // fallback was the only path that ever ran.)
    probeSession.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
      if (!settled && languageReady && !apiFetchAttempted && API_DOMAINS.some((d) => details.url.includes(d))) {
        apiFetchAttempted = true;
        const generation = documentGeneration;
        fetchAndFindManifest(pageUrl, details.url, signal).then((scan) => {
          if (settled || !scan.manifestUrl || generation !== documentGeneration) return;
          let referer = pageUrl;
          try { referer = new URL(details.url).origin + '/'; } catch { /* keep the page */ }
          for (const url of scan.subtitles) subtitles.set(url, { url, referer });
          const type = mediaTypeFromUrl(scan.manifestUrl) || 'm3u8';
          accept({ originalUrl: pageUrl, manifestUrl: scan.manifestUrl, type, referer }, ' via API response fetch');
        }).catch(() => { });
      }
      callback({});
    });

    // A failed load ends or retries the probe only when it is the page itself.
    // Every failure used to count: a broken ad iframe ended a healthy probe,
    // and the retry called loadURL again, which aborted the pending loadURL
    // whose catch then ended the probe — "Page load failed (-105)", "Retrying
    // load…", "loadURL error: ERR_ABORTED (-3)" within 20ms, 47 times in one
    // real session. The loadURL promises no longer decide anything; this does.
    win.webContents.on('did-fail-load', (_event, code, desc, _url, isMainFrame) => {
      if (settled || !isMainFrame || code === -3) return;
      log.warn(`[manifest-extractor] Page load failed (${code}): ${desc} for ${pageUrl}`);
      if (!RETRYABLE_LOAD_ERRORS.has(code) || reloadsLeft <= 0) {
        finish(null);
        return;
      }
      reloadsLeft--;
      log.info('[manifest-extractor] Retrying load due to network failure...');
      retryTimer = setTimeout(() => { if (!settled) win.loadURL(pageUrl).catch(() => { }); }, NETWORK_RETRY_DELAY_MS);
    });

    // After the page settles with no manifest found, reload once as a retry.
    // Some sites need a second pass after all JS initialises. One timer, reset
    // by each load: it used to be one listener per load, each arming its own.
    win.webContents.on('did-finish-load', () => {
      if (settled) return;
      readPageContext(' via JS context after load').catch(() => { });
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        if (settled) return;
        if (reloadsLeft <= 0) {
          giveUp('Still no manifest after reload');
          return;
        }
        reloadsLeft--;
        log.info(`[manifest-extractor] No manifest yet after ${POST_LOAD_WAIT_MS}ms, reloading once…`);
        win.loadURL(pageUrl).catch(() => { });
      }, POST_LOAD_WAIT_MS);
    });

    log.info(`[manifest-extractor] Probing ${pageUrl}`);
    win.loadURL(pageUrl).catch((err) => {
      // did-fail-load has already decided what this failure means.
      log.debug(`[manifest-extractor] loadURL settled with: ${err}`);
    });
  });
}

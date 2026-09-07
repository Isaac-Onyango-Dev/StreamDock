// Role: loads a page in a hidden BrowserWindow to intercept .m3u8 / .mpd manifest
// URLs that are only reachable through JavaScript-based video players.

import { app, BrowserWindow, net, session } from 'electron';
import log from 'electron-log';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { resolveYtDlpCommand } from './binary-resolver';
import { getProbeStrategy } from './url-router';

const execFileAsync = promisify(execFile);

/**
 * `--dump-json` for a single YouTube video is routinely several megabytes —
 * every format, every fragment list. The default 1MB stdout buffer aborted the
 * probe with ERR_CHILD_PROCESS_STDIO_MAXBUFFER before a line of it was parsed,
 * which is what silently cost the UI its title and thumbnail on YouTube.
 */
const PROBE_MAX_BUFFER = 64 * 1024 * 1024;

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

export async function probeViaYtDlp(url: string): Promise<StreamManifest> {
  const ytDlpCmd = resolveYtDlpCommand();
  // execFile with an argument array rather than a shell string: no quoting to
  // get wrong, and a URL containing shell metacharacters cannot be interpreted
  // as anything but an argument. `--` ends option parsing.
  const result = await execFileAsync(
    ytDlpCmd.command,
    // --no-playlist because this probe describes ONE media item. Without it a
    // URL carrying `list=` (every YouTube radio mix, every "watch later" link)
    // makes yt-dlp emit one JSON object per entry — for a radio mix, an
    // effectively endless stream of them that no buffer size can absorb.
    [...ytDlpCmd.args, '--dump-json', '--no-playlist', '--no-download', '--no-warnings', '--', url],
    { windowsHide: true, maxBuffer: PROBE_MAX_BUFFER, encoding: 'utf-8' },
  );
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

export interface ManifestResult {
  originalUrl: string;
  manifestUrl: string;
  type: 'm3u8' | 'mpd' | 'mp4';
  referer?: string;
  /** Path to a Netscape-format cookies.txt for this CDN domain, if available. */
  cookiesFile?: string;
}

export interface ApiProbeResult {
  url: string;
  referer?: string;
  /** Path to a Netscape-format cookies.txt written from the embed-page response cookies. */
  cookiesFile?: string;
}

/** Look for manifest URLs and segment patterns that indicate an HLS/DASH stream. */
const MANIFEST_PATTERN = /\.(m3u8|mpd|mp4)(\?|$)/i;
const SEGMENT_PATTERN = /\/hls\/|hls\/\d+|[?&]hls|\.m3u8(?:\?|$)|\.mpd(?:\?|$)|\.ts(?:\?|$)|\.m4s(?:\?|$)|manifest(?:\.[a-z]+)?\?(?:.*&)?(?:type|fmt|file)/i;

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

function mediaTypeFromUrl(url: string): ManifestResult['type'] | null {
  const match = url.match(/\.(m3u8|mpd|mp4)(?:\?|$)/i);
  return match ? match[1].toLowerCase() as ManifestResult['type'] : null;
}

function isPlayableUrl(url: string): boolean {
  return Boolean(mediaTypeFromUrl(url)) || KNOWN_CDNS.some((cdn) => url.includes(cdn));
}


/**
 * Timeout in milliseconds for manifest discovery. If no manifest is found
 * within this window the promise resolves with `null`.
 */
const EXTRACTION_TIMEOUT_MS = 45_000;

/**
 * How long to wait after page load before triggering a reload retry
 * (in case the page uses delayed JS initialization).
 */
const POST_LOAD_WAIT_MS = 10_000;

/**
 * Chrome-like user-agent to avoid headless detection.
 * Matches the user's real Chrome 148 on Windows.
 */
const SPOOF_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

/**
 * Preload script injected into the BrowserWindow to spoof automation
 * detection properties that sites use to block headless browsers.
 */
const PRELOAD_SPOOF = `
// Override navigator properties that bots expose
Object.defineProperty(navigator, 'webdriver', { get: () => false });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
// Override chrome.runtime to look like a real extension is present
if (window.chrome) {
  Object.defineProperty(chrome, 'runtime', { get: () => ({}) });
}
`;

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

/** Fetch a URL from the main process and parse its body for manifest URLs. */
function fetchAndFindManifest(pageUrl: string, apiUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const request = net.request({
        method: 'GET',
        url: apiUrl,
        headers: {
          'User-Agent': SPOOF_UA,
          Referer: pageUrl,
          Accept: 'application/json, text/plain, */*',
        },
      });
      let body = '';
      request.on('response', (response) => {
        response.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        response.on('end', () => {
          if (!body.trim()) { resolve(null); return; }
          // Try parsing as JSON and extract any URL-like string values
          let foundUrl: string | null = null;
          try {
            const parsed = JSON.parse(body);
            // Walk JSON values looking for URLs
            const walk = (obj: unknown, depth = 0): void => {
              if (depth > 5 || foundUrl) return;
              if (typeof obj === 'string') {
                if (obj.startsWith('http') && isPlayableUrl(obj) && !foundUrl) foundUrl = obj;
              } else if (Array.isArray(obj)) {
                obj.forEach((v) => walk(v, depth + 1));
              } else if (obj && typeof obj === 'object') {
                for (const val of Object.values(obj as Record<string, unknown>)) {
                  walk(val, depth + 1);
                  if (foundUrl) break;
                }
              }
            };
            walk(parsed);
          } catch { /* not JSON, fall through */ }

          if (foundUrl) return resolve(foundUrl);

          // Fallback: regex search for .m3u8 / .mpd URLs
          let text = body;
          try { text = JSON.stringify(JSON.parse(body)); } catch { /* use raw */ }
          const m = text.match(/(https?:\/\/[^\s"'<>",}]+?\.(?:m3u8|mpd|mp4)[^\s"'<>",}]*)/i);
          resolve(m ? m[1] : null);
        });
        response.on('error', () => resolve(null));
      });
      request.on('error', () => resolve(null));
      request.end();
    } catch { resolve(null); }
  });
}

/**
 * Make a plain HTTP GET request using Electron's net module (bypasses
 * BrowserWindow and reCAPTCHA entirely). Returns the response body text
 * or `null` on failure.
 */
interface FetchResult {
  body: string | null;
  /** Raw Set-Cookie header values from the response. */
  setCookies: string[];
}

/**
 * Low-level fetch that returns the response body AND any Set-Cookie headers.
 * Used by tryResolveEmbedUrl so we can export session cookies to yt-dlp.
 */
function fetchUrlRaw(url: string, extraHeaders: Record<string, string>): Promise<FetchResult> {
  return new Promise((resolve) => {
    try {
      const request = net.request({
        method: 'GET',
        url,
        headers: {
          'User-Agent': SPOOF_UA,
          'Accept-Language': 'en-US,en;q=0.9',
          ...extraHeaders,
        },
      });
      let body = '';
      let setCookies: string[] = [];
      request.on('response', (response) => {
        const raw = response.headers['set-cookie'];
        if (Array.isArray(raw)) setCookies = raw;
        else if (typeof raw === 'string') setCookies = [raw];
        response.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        response.on('end', () => resolve({ body: body || null, setCookies }));
        response.on('error', () => resolve({ body: null, setCookies: [] }));
      });
      request.on('error', () => resolve({ body: null, setCookies: [] }));
      request.end();
    } catch { resolve({ body: null, setCookies: [] }); }
  });
}

/**
 * Convert an array of raw Set-Cookie header strings into a Netscape-format
 * cookies.txt that yt-dlp can consume via --cookies.
 */
function parseSetCookieToNetscape(setCookies: string[], baseUrl: string): string {
  const lines = ['# Netscape HTTP Cookie File', '# Generated by StreamDock manifest-extractor'];
  try {
    const defaultDomain = new URL(baseUrl).hostname;
    for (const cookie of setCookies) {
      const [nameValue, ...attrs] = cookie.split(/;\s*/);
      const eqIdx = nameValue.indexOf('=');
      if (eqIdx === -1) continue;
      const name = nameValue.substring(0, eqIdx).trim();
      const value = nameValue.substring(eqIdx + 1).trim();
      let domain = defaultDomain;
      let path = '/';
      let secure = false;
      let expiry = 0;
      for (const attr of attrs) {
        const eqPos = attr.indexOf('=');
        const k = (eqPos !== -1 ? attr.substring(0, eqPos) : attr).trim().toLowerCase();
        const v = eqPos !== -1 ? attr.substring(eqPos + 1).trim() : '';
        if (k === 'domain' && v) domain = v;
        else if (k === 'path' && v) path = v;
        else if (k === 'secure') secure = true;
        else if (k === 'expires' && v) {
          const d = new Date(v);
          if (!isNaN(d.getTime())) expiry = Math.floor(d.getTime() / 1000);
        } else if (k === 'max-age' && v) {
          const maxAge = parseInt(v, 10);
          if (!isNaN(maxAge)) expiry = Math.floor(Date.now() / 1000) + maxAge;
        }
      }
      const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE';
      lines.push(`${domain}\t${flag}\t${path}\t${secure ? 'TRUE' : 'FALSE'}\t${expiry}\t${name}\t${value}`);
    }
  } catch { /* ignore malformed cookies */ }
  return lines.join('\n');
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
async function tryAnikotoApi(pageUrl: string): Promise<ApiProbeResult | null> {
  // --- Step 1: Fetch the page HTML AND capture cookies ---
  const { body: pageHtml, setCookies: pageCookies } = await fetchUrlRaw(pageUrl, { Referer: 'https://anikoto.cz/' });
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
  const { body: epListHtml, setCookies: epListCookies } = await fetchUrlRaw(epListUrl, { Referer: pageUrl });
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
        return fetchMapperApi(pageUrl, malId, epSlug, timestamp || '0', allCookies);
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
  incomingCookies: string[] = [],
): Promise<ApiProbeResult | null> {
  const mapperUrl = `https://mapper.nekostream.site/api/mal/${malId}/${epSlug}/${timestamp}`;
  const { body: json, setCookies: mapperCookies } = await fetchUrlRaw(mapperUrl, {
    Referer: pageUrl,
    Accept: 'application/json, text/plain, */*',
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

     if (foundUrl) {
       log.info(`[manifest-extractor] anikoto: found media URL via API: ${foundUrl}`);
// If it's an embed page, resolve it
        if (!MANIFEST_PATTERN.test(foundUrl) && !KNOWN_CDNS.some(c => foundUrl!.includes(c))) {
          const resolved = await tryResolveEmbedUrl(foundUrl, 'https://anikoto.cz/', allCookies);
          if (resolved) {
            try {
              const embedOrigin = new URL(foundUrl).origin + '/';
              return { url: resolved.url, referer: embedOrigin, cookiesFile: resolved.cookiesFile };
            } catch {
              return { url: resolved.url, referer: foundUrl, cookiesFile: resolved.cookiesFile };
            }
          }
          return null;
        }
        // For direct manifest URLs, pass the accumulated cookies
        if (allCookies.length > 0) {
          try {
            const cookieDir = join(app.getPath('userData'), 'manifest-probe');
            if (!existsSync(cookieDir)) mkdirSync(cookieDir, { recursive: true });
            const cookiePath = join(cookieDir, `cookies-${Date.now()}.txt`);
            writeFileSync(cookiePath, parseSetCookieToNetscape(allCookies, pageUrl), 'utf-8');
            log.info(`[manifest-extractor] Wrote ${allCookies.length} combined cookie(s) → ${cookiePath}`);
            return { url: foundUrl, referer: 'https://anikoto.cz/', cookiesFile: cookiePath };
          } catch (err) {
            log.warn('[manifest-extractor] Could not write cookies file:', err);
          }
        }
        return { url: foundUrl, referer: 'https://anikoto.cz/' };
     }

     return null;
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
  incomingCookies: string[] = [],
): Promise<{ url: string; cookiesFile?: string } | null> {
  // Rate-limit sequential embed-page CDN requests (secondary safeguard alongside
  // the serialized extraction mutex in the engine).
  await new Promise(resolve => setTimeout(resolve, 500));

  // Use fetchUrlRaw so we can capture Set-Cookie headers from the embed CDN.
  const { body: html, setCookies } = await fetchUrlRaw(embedUrl, { Referer: referer });
  if (!html) return null;

  // Combine incoming cookies with embed page cookies
  const allCookies = [...incomingCookies, ...setCookies];

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
  let cookiesFile: string | undefined;
  if (allCookies.length > 0) {
    try {
      const cookieDir = join(app.getPath('userData'), 'manifest-probe');
      if (!existsSync(cookieDir)) mkdirSync(cookieDir, { recursive: true });
      const cookiePath = join(cookieDir, `cookies-${Date.now()}.txt`);
      writeFileSync(cookiePath, parseSetCookieToNetscape(allCookies, embedUrl), 'utf-8');
      cookiesFile = cookiePath;
      log.info(`[manifest-extractor] Wrote ${allCookies.length} combined cookie(s) → ${cookiePath}`);
    } catch (err) {
      log.warn('[manifest-extractor] Could not write cookies file:', err);
    }
  }

  return { url: manifestUrl, cookiesFile };
}

/**
 * Try to resolve a manifest URL via direct HTTP API calls instead of a
 * BrowserWindow. Handles known API-based sites like anikoto.cz.
 */
async function tryApiProbe(pageUrl: string): Promise<ApiProbeResult | null> {
  try {
    const host = new URL(pageUrl).hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'anikoto.cz') return tryAnikotoApi(pageUrl);
    return null;
  } catch { return null; }
}

/**
 * Loads `pageUrl` in an off-screen Electron BrowserWindow, intercepts every
 * network request, and returns the first `.m3u8` or `.mpd` URL it sees.
 *
 * If the first full page load + wait completes without finding a manifest,
 * the page is reloaded once (some sites need a second pass to initialise the
 * video player).
 *
 * Returns `null` if no manifest is discovered before the timeout.
 */
export async function extractManifest(pageUrl: string): Promise<ManifestResult | null> {
  if (getProbeStrategy(pageUrl) === 'ytdlp') {
    try {
      log.info(`[manifest-extractor] Routing to yt-dlp probe: ${pageUrl}`);
      const manifest = await probeViaYtDlp(pageUrl);
      const hlsFormat = manifest.formats.find(f => f.ext === 'mp4' && f.url.includes('m3u8'))
                     || manifest.formats.find(f => f.url.includes('m3u8') || f.url.includes('mpd'));
      if (hlsFormat) {
        const type = hlsFormat.url.includes('mpd') ? 'mpd' : 'm3u8';
        return { originalUrl: pageUrl, manifestUrl: hlsFormat.url, type, referer: pageUrl };
      }
      return null;
    } catch (e) {
      log.warn(`[manifest-extractor] yt-dlp probe failed: ${e}`);
      return null;
    }
  }

  // --- Fast-path: try direct API probe first (avoids BrowserWindow) ---
  const apiResult = await tryApiProbe(pageUrl);
  if (apiResult) {
    const type = mediaTypeFromUrl(apiResult.url) || 'm3u8';
    log.info(`[manifest-extractor] Returning URL from direct API probe: ${apiResult.url}`);
    return { originalUrl: pageUrl, manifestUrl: apiResult.url, type, referer: apiResult.referer, cookiesFile: apiResult.cookiesFile };
  }

  // --- Fall back to hidden BrowserWindow for JavaScript-rendered video players ---
  const partitionName = `manifest-probe-${Date.now()}`;
  // Use persistent session so cookies/localStorage are available
  const probeSession = session.fromPartition(partitionName, { cache: true });

  // Write the preload spoof script to disk so it runs before any page JS
  const preloadDir = join(app.getPath('userData'), 'manifest-probe');
  if (!existsSync(preloadDir)) mkdirSync(preloadDir, { recursive: true });
  const preloadPath = join(preloadDir, `spoof-${randomUUID()}.js`);
  writeFileSync(preloadPath, PRELOAD_SPOOF, 'utf-8');

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: {
      session: probeSession,
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  // Priority 1: Mute audio immediately (before loadURL)
  win.webContents.setAudioMuted(true);

  // Priority 2: Prevent ad popups
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  return probeOnce(win, probeSession, pageUrl, preloadPath);
}

async function probeOnce(
  win: BrowserWindow,
  probeSession: Electron.Session,
  pageUrl: string,
  preloadPath?: string,
  isRetry = false,
): Promise<ManifestResult | null> {
  return new Promise<ManifestResult | null>((resolve) => {
    let settled = false;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: ManifestResult | null) => {
      if (settled) return;
      settled = true;
      if (reloadTimer) clearTimeout(reloadTimer);
      try { if (preloadPath) rmSync(preloadPath, { force: true }); } catch { /* temp file cleanup is best-effort */ }
      cleanup();
      resolve(result);
    };

    const manifestFromStr = (urls: string[]): ManifestResult | null => {
      for (const u of urls) {
        const type = mediaTypeFromUrl(u);
        if (type) return { originalUrl: pageUrl, manifestUrl: u, type, referer: pageUrl };
      }
      return null;
    };

    const timeout = setTimeout(() => {
      // Before giving up, try JS context extraction as a last resort
      if (!settled) {
        win.webContents.executeJavaScript(EXTRACT_JS).then((urls: string[]) => {
          const found = manifestFromStr(urls);
          if (found) {
            log.info(`[manifest-extractor] Found manifest via JS context: ${found.manifestUrl}`);
            finish(found);
            return;
          }
          log.warn(`[manifest-extractor] Timed out after ${EXTRACTION_TIMEOUT_MS}ms for ${pageUrl}`);
          finish(null);
        }).catch(() => {
          log.warn(`[manifest-extractor] Timed out after ${EXTRACTION_TIMEOUT_MS}ms for ${pageUrl}`);
          finish(null);
        });
      }
    }, EXTRACTION_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      try { win.destroy(); } catch { /* already gone */ }
      probeSession.clearStorageData().catch(() => { });
    };

    // Spoof user-agent
    win.webContents.setUserAgent(SPOOF_UA);

    // Aggressive auto-click: play buttons, player containers, and video elements
    win.webContents.on('dom-ready', () => {
      win.webContents.executeJavaScript(`
        const tryClick = (sel) => {
          document.querySelectorAll(sel).forEach(el => {
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
      `).catch(() => { });
    });

    // Intercept requests and responses. Use separate handlers for:
    //  - onBeforeRequest: fast-path manifest detection and optional cancel
    //  - onBeforeSendHeaders: ensure UA/Accept-Language headers
    //  - onHeadersReceived: inspect JSON API responses via filterResponseData
    let apiFetchAttempted = false;

    // Fast-path: detect direct manifest requests and CDN-hosted manifests
    probeSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      try {
        if (settled) { callback({ cancel: true }); return; }
        const match = details.url.match(MANIFEST_PATTERN);
        if (match) {
          const type = match[1].toLowerCase() as ManifestResult['type'];
          log.info(`[manifest-extractor] Found ${type} manifest: ${details.url}`);
          // Cancel the request to avoid letting the player consume it
          callback({ cancel: true });
          finish({ originalUrl: pageUrl, manifestUrl: details.url, type, referer: pageUrl });
          return;
        }

        if (KNOWN_CDNS.some((cdn) => details.url.includes(cdn)) && (MANIFEST_PATTERN.test(details.url) || details.url.includes('/hls/'))) {
          log.info(`[manifest-extractor] Found CDN manifest: ${details.url}`);
          callback({ cancel: true });
          finish({ originalUrl: pageUrl, manifestUrl: details.url, type: 'm3u8', referer: pageUrl });
          return;
        }

        // Heuristic: if this looks like a segment list or API that might contain
        // manifest info, note it for potential background fetches.
        if (!apiFetchAttempted && SEGMENT_PATTERN.test(details.url) && !details.url.includes('.ts') && !details.url.includes('.m4s')) {
          log.info(`[manifest-extractor] Possible manifest via pattern: ${details.url}`);
        }
      } catch {
        // swallow: this handler must never throw and block navigation
      }
      callback({});
    });

    // Ensure outgoing headers include Accept-Language / User-Agent
    probeSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
      try {
        const headers = { ...details.requestHeaders } as Record<string, string>;
        if (!headers['Accept-Language'] && !headers['accept-language']) headers['Accept-Language'] = 'en-US,en;q=0.9';
        if (!headers['User-Agent'] && !headers['user-agent']) headers['User-Agent'] = SPOOF_UA;
        callback({ requestHeaders: headers });
        return;
      } catch {
        callback({});
        return;
      }
    });

    // Inspect JSON responses for embedded manifest URLs using a response filter
    probeSession.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
      try {
        const rawCt = (details.responseHeaders && (details.responseHeaders['content-type'] || details.responseHeaders['Content-Type'])) || [];
        const ct = Array.isArray(rawCt) ? rawCt[0] : (rawCt || '');
        const isJson = /application\/(json|javascript)|text\/json|text\/plain/i.test(String(ct)) || API_DOMAINS.some(d => details.url.includes(d));

        if (isJson) {
          try {
            // @ts-expect-error - filterResponseData is an Electron API that may not be fully typed
            const filter = probeSession.webRequest.filterResponseData(details.requestId);
            const chunks: Buffer[] = [];
            filter.on('data', (chunk: Buffer) => {
              chunks.push(Buffer.from(chunk));
              filter.write(chunk);
            });
            filter.on('end', () => {
              try {
                const body = Buffer.concat(chunks).toString('utf8');
                // quick regex search for manifest URLs
                const m = body.match(/(https?:\/\/[^\s"'<>{},]+?\.(?:m3u8|mpd|mp4)[^\s"'<>}]*)/i);
                if (m && !settled) {
                  const manifestUrl = m[1];
                  const type = mediaTypeFromUrl(manifestUrl) || 'm3u8';
                  log.info(`[manifest-extractor] Found manifest in API response: ${manifestUrl}`);
                  const embedOrigin = new URL(details.url).origin + '/';
                  finish({ originalUrl: pageUrl, manifestUrl, type, referer: embedOrigin });
                }
              } catch {
                // ignore parse errors
              } finally {
                filter.end();
              }
            });
          } catch {
            // filterResponseData not supported or failed — fall back to background fetch
            if (!apiFetchAttempted && API_DOMAINS.some((d) => details.url.includes(d))) {
              apiFetchAttempted = true;
              fetchAndFindManifest(pageUrl, details.url).then((manifestUrl) => {
                if (settled || !manifestUrl) return;
                const type = mediaTypeFromUrl(manifestUrl) || 'm3u8';
                log.info(`[manifest-extractor] Found manifest via API response fetch: ${manifestUrl}`);
                const embedOrigin = new URL(details.url).origin + '/';
                finish({ originalUrl: pageUrl, manifestUrl, type, referer: embedOrigin });
              }).catch(() => { });
            }
          }
        }
      } catch {
        // ignore
      }
      callback({});
    });

    // Handle navigation / load failures gracefully.
    win.webContents.on('did-fail-load', (_event, code, desc) => {
      log.warn(`[manifest-extractor] Page load failed (${code}): ${desc} for ${pageUrl}`);
      if (!isRetry && (code === -2 || code === -3 || code === -105)) {
        log.info('[manifest-extractor] Retrying load due to network failure...');
        win.loadURL(pageUrl).catch(() => finish(null));
      } else {
        finish(null);
      }
    });

    // After the page settles with no manifest found, reload once as a retry.
    // Some sites need a second pass after all JS initialises.
    if (!isRetry) {
      win.webContents.on('did-finish-load', () => {
        if (settled) return;
        // Try JS context extraction after page load
        win.webContents.executeJavaScript(EXTRACT_JS).then((urls: string[]) => {
          if (settled) return;
          const found = manifestFromStr(urls);
          if (found) {
            log.info(`[manifest-extractor] Found manifest via JS context after load: ${found.manifestUrl}`);
            finish(found);
            return;
          }
        }).catch(() => { });

        reloadTimer = setTimeout(() => {
          if (settled) return;
          log.info(`[manifest-extractor] No manifest yet after ${POST_LOAD_WAIT_MS}ms, reloading once…`);
          win.webContents.once('did-finish-load', () => {
            if (settled) return;
            // Try JS context again after reload
            win.webContents.executeJavaScript(EXTRACT_JS).then((urls: string[]) => {
              if (settled) return;
              const found = manifestFromStr(urls);
              if (found) {
                log.info(`[manifest-extractor] Found manifest via JS context after reload: ${found.manifestUrl}`);
                finish(found);
                return;
              }
            }).catch(() => { });

            reloadTimer = setTimeout(() => {
              if (!settled) {
                log.warn(`[manifest-extractor] Still no manifest after reload for ${pageUrl}`);
                finish(null);
              }
            }, POST_LOAD_WAIT_MS);
          });
          win.loadURL(pageUrl).catch(() => { });
        }, POST_LOAD_WAIT_MS);
      });
    } else {
      win.webContents.on('did-finish-load', () => {
        if (settled) return;

        win.webContents.executeJavaScript(EXTRACT_JS).then((urls: string[]) => {
          if (settled) return;
          const found = manifestFromStr(urls);
          if (found) {
            log.info(`[manifest-extractor] Found manifest via JS context (retry): ${found.manifestUrl}`);
            finish(found);
            return;
          }
        }).catch(() => { });

        reloadTimer = setTimeout(() => {
          if (!settled) finish(null);
        }, POST_LOAD_WAIT_MS);
      });
    }

    log.info(`[manifest-extractor] Probing${isRetry ? ' (retry)' : ''} ${pageUrl}`);
    win.loadURL(pageUrl).catch((err) => {
      log.warn(`[manifest-extractor] loadURL error: ${err}`);
      finish(null);
    });
  });
}

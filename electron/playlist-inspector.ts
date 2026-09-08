// Role: safe metadata probe for single videos, playlists, and stream pages.
import { spawn } from 'child_process';
import { get as httpsGet } from 'https';
import { buildPluginDirArgs, resolveBinary, resolveYtDlpCommand } from './binary-resolver';
import { ANIME_HOSTS, EPISODE_PATTERNS, MANIFEST_PROBE_HOSTS, PLUGIN_EXTRACTOR_HOSTS, REFERENCE_HOSTS } from './url-router';

export type ProbeSupport = 'direct' | 'playlist' | 'episode-range' | 'manifest-probe' | 'unknown';

export interface PlaylistProbeItem {
  id?: string;
  title: string;
  url?: string;
  duration?: number;
  thumbnail?: string;
}

export interface QualityOption {
  height: number;
  label: string;
}

export interface PlaylistProbe {
  url: string;
  host: string;
  title: string;
  support: ProbeSupport;
  itemCount: number;
  preview: PlaylistProbeItem[];
  qualityOptions?: QualityOption[];
  thumbnail?: string;
  extractor?: string;
  isLive: boolean;
  notes: string[];
}

interface YtDlpInfo {
  id?: string;
  title?: string;
  url?: string;
  webpage_url?: string;
  original_url?: string;
  extractor?: string;
  extractor_key?: string;
  live_status?: string;
  /** Real playlist length, independent of --playlist-end. */
  playlist_count?: number;
  duration?: number;
  thumbnail?: string;
  /** Present instead of `thumbnail` on --flat-playlist entries. */
  thumbnails?: Array<{ url?: string }>;
  formats?: Array<{
    height?: number;
    vcodec?: string;
    protocol?: string;
  }>;
  entries?: Array<YtDlpInfo | null>;
}

const PROBE_TIMEOUT_MS = 25_000;
const FULL_PROBE_TIMEOUT_MS = 60_000;
const PAGE_FETCH_TIMEOUT_MS = 15_000;

/**
 * How many probed items to hand the UI.
 *
 * A display cap only. It never affects `itemCount`, which always reports the
 * real total — a preview list that stops at N must not become a claim that
 * there are N items, in either direction.
 */
const PREVIEW_LIMIT = 200;

export interface EpisodePattern {
  title: string;
  currentEpisode: number;
  createUrl: (episode: number) => string;
}

function hostFromUrl(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
}

function matchesHost(host: string, domains: string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * Best available poster for one probed item.
 *
 * `--flat-playlist` entries carry a `thumbnails[]` array and no scalar
 * `thumbnail`, so reading only the scalar found nothing for every playlist
 * item — which is why playlist rows showed a placeholder icon in both the
 * preview list and the download queue. The array is ordered smallest-first,
 * so the last entry is the largest.
 */
export function pickThumbnail(entry: YtDlpInfo | null): string | undefined {
  if (entry?.thumbnail) return entry.thumbnail;
  const list = entry?.thumbnails;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const url = list[i]?.url;
    if (url) return url;
  }
  return undefined;
}

function toItem(entry: YtDlpInfo | null, index: number): PlaylistProbeItem {
  return {
    id: entry?.id,
    title: entry?.title || `Episode ${index + 1}`,
    url: entry?.webpage_url || entry?.url,
    duration: entry?.duration,
    thumbnail: pickThumbnail(entry),
  };
}

function cleanSeries(value: string): string {
  return value
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function detectEpisodePattern(rawUrl: string): EpisodePattern | null {
  const parsed = new URL(rawUrl);
  const host = hostFromUrl(rawUrl);

  for (const config of EPISODE_PATTERNS()) {
    if (!matchesHost(host, config.hosts ?? [])) continue;
    // A host must say where its episode number lives; without either field
    // there is no way to walk to the next episode.
    if (!config.episodeParam && !config.nextPath) continue;

    let pathMatch: RegExpMatchArray | null = null;
    try {
      pathMatch = parsed.pathname.match(new RegExp(config.pathPattern, 'i'));
    } catch {
      // One malformed pattern in the config must not stop every other host
      // from being probed.
      continue;
    }

    const series = pathMatch?.groups?.series;
    if (!series) continue;

    const episode = config.episodeParam
      ? Number(parsed.searchParams.get(config.episodeParam))
      : Number(pathMatch?.groups?.episode);
    if (!Number.isFinite(episode) || episode <= 0) continue;

    const name = cleanSeries(series);
    const title = config.titlePrefix ? `${config.titlePrefix} ${name}` : name;

    return {
      title,
      currentEpisode: episode,
      createUrl: (nextEpisode) => {
        if (config.episodeParam) {
          const next = new URL(rawUrl);
          next.searchParams.set(config.episodeParam, String(nextEpisode));
          return next.toString();
        }
        const path = (config.nextPath ?? '')
          .replace(/\{series\}/g, series)
          .replace(/\{episode\}/g, String(nextEpisode));
        return `${parsed.origin}${path}`;
      },
    };
  }

  return null;
}

/**
 * Series metadata read from the source page itself.
 *
 * The episode total has to come from the site. Deriving it from the URL is what
 * produced the overshoot: the previous version generated a fixed 200 synthetic
 * entries starting at whatever episode the user happened to paste, and reported
 * `itemCount: 999` regardless — so a 366-episode show was listed as having 999,
 * and the "episodes" past the real end were URLs that resolve to nothing.
 */
interface SeriesInfo {
  totalEpisodes?: number;
  title?: string;
  thumbnail?: string;
}

/** Fetch a page as text, following redirects. Resolves to null on any failure. */
function fetchPage(url: string, redirectsLeft = 3): Promise<string | null> {
  return new Promise((resolve) => {
    const request = httpsGet(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
          response.resume();
          resolve(fetchPage(new URL(location, url).toString(), redirectsLeft - 1));
          return;
        }
        if (status !== 200) {
          response.resume();
          resolve(null);
          return;
        }
        let body = '';
        response.setEncoding('utf-8');
        response.on('data', (chunk: string) => {
          // Series metadata lives in the document head/meta block; no need to
          // buffer megabytes of episode-grid markup to find it.
          if (body.length < 512_000) body += chunk;
        });
        response.on('end', () => resolve(body));
      },
    );
    request.on('error', () => resolve(null));
    request.setTimeout(PAGE_FETCH_TIMEOUT_MS, () => {
      request.destroy();
      resolve(null);
    });
  });
}

/** Read the real episode total, series title and poster out of a series page. */
export function parseSeriesInfo(html: string): SeriesInfo {
  const info: SeriesInfo = {};

  // "Episodes: <span> 366</span>" and the common structured-data variants.
  const totalMatch =
    html.match(/Episodes?\s*:?\s*<\/?[a-z][^>]*>\s*(\d{1,5})\s*</i) ||
    html.match(/"numberOfEpisodes"\s*:\s*"?(\d{1,5})"?/i) ||
    html.match(/\b(?:total_?episodes|episodeCount)\b["'\s:=]+(\d{1,5})/i);
  if (totalMatch) {
    const total = Number(totalMatch[1]);
    if (Number.isFinite(total) && total > 0 && total <= 10_000) info.totalEpisodes = total;
  }

  const titleMatch =
    html.match(/itemprop=["']name["'][^>]*class=["'][^"']*d-title[^"']*["'][^>]*>\s*([^<]{1,120}?)\s*</i) ||
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{1,160})["']/i);
  if (titleMatch) info.title = decodeEntities(titleMatch[1].trim());

  const thumbMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (thumbMatch) info.thumbnail = thumbMatch[1].trim();

  return info;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Build an episode-range probe from the episodes that actually exist.
 *
 * Every entry is a real episode of a series whose length the source page
 * reported. When the page does not state a length, nothing is extrapolated —
 * the probe returns only the episode the user actually pasted, and says so.
 * Guessing a longer list is what put episodes 367..999 of a 366-episode show
 * in front of the user.
 */
async function episodeRangeProbe(url: string, pattern: EpisodePattern): Promise<PlaylistProbe> {
  const html = await fetchPage(url);
  const series = html ? parseSeriesInfo(html) : {};
  const seriesTitle = series.title || pattern.title;
  const total = series.totalEpisodes;

  const notes: string[] = [];
  let episodes: number[];

  if (total) {
    episodes = Array.from({ length: total }, (_, index) => index + 1);
    notes.push(`${seriesTitle} has ${total} episodes according to ${hostFromUrl(url)}.`);
  } else {
    // Unknown length: offer exactly what we can stand behind.
    episodes = [pattern.currentEpisode];
    notes.push(
      `Could not read an episode count from ${hostFromUrl(url)}, so only episode ` +
      `${pattern.currentEpisode} is listed. Use Range to queue a span you know exists.`,
    );
  }

  notes.push('StreamDock will still use browser manifest probing for each episode page.');

  return {
    url,
    host: hostFromUrl(url),
    title: seriesTitle,
    support: 'episode-range',
    itemCount: episodes.length,
    preview: episodes.map((episode) => ({
      id: String(episode),
      title: `${seriesTitle} - Episode ${episode}`,
      url: pattern.createUrl(episode),
      thumbnail: series.thumbnail,
    })),
    thumbnail: series.thumbnail,
    isLive: false,
    notes,
  };
}

function parseInfo(url: string, stdout: string): PlaylistProbe {
  const info = JSON.parse(stdout) as YtDlpInfo;
  const host = hostFromUrl(url);
  const entries = Array.isArray(info.entries) ? info.entries.filter(Boolean) : [];

  // The probe passes --playlist-end 500, so `entries` is capped and is not a
  // count of the playlist. yt-dlp reports the real total separately; prefer it
  // so a 900-item playlist is not announced as having exactly 500.
  const reportedTotal = Number(info.playlist_count);
  const itemCount = Number.isFinite(reportedTotal) && reportedTotal > 0
    ? reportedTotal
    : (entries.length || 1);
  const support: ProbeSupport = entries.length > 1 ? 'playlist' : 'direct';

  return {
    url: info.webpage_url || info.original_url || url,
    host,
    title: info.title || (entries.length > 1 ? 'Detected playlist' : 'Detected media'),
    support,
    itemCount,
    preview: entries.length > 0 ? entries.slice(0, PREVIEW_LIMIT).map(toItem) : [toItem(info, 0)],
    qualityOptions: entries.length === 0 ? extractQualityOptions(info) : undefined,
    // A playlist has no poster of its own; fall back to its first item's, so
    // the queue row and preview header are not left with a placeholder icon.
    thumbnail: pickThumbnail(info) ?? pickThumbnail(entries[0] ?? null),
    extractor: info.extractor_key || info.extractor,
    isLive: info.live_status === 'is_live',
    notes: [
      entries.length > PREVIEW_LIMIT
        ? `Showing the first ${PREVIEW_LIMIT} of ${itemCount} items.`
        : 'Metadata probe completed.',
    ],
  };
}

function extractQualityOptions(info: YtDlpInfo): QualityOption[] | undefined {
  const heights = new Set<number>();

  for (const format of info.formats || []) {
    const height = Number(format.height);
    if (!Number.isFinite(height) || height <= 0) continue;
    if (!format.vcodec || format.vcodec === 'none') continue;
    heights.add(height);
  }

  const sorted = Array.from(heights).sort((a, b) => b - a);
  if (sorted.length === 0) return undefined;
  return sorted.map((height) => ({ height, label: `${height}p` }));
}

async function fallbackProbe(url: string, reason: string): Promise<PlaylistProbe> {
  const host = hostFromUrl(url);
  if (matchesHost(host, REFERENCE_HOSTS())) {
    return {
      url,
      host,
      title: 'EverythingMoe reference index',
      support: 'unknown',
      itemCount: 1,
      preview: [{ title: 'Choose a listed source page, then paste that source URL into StreamDock' }],
      isLive: false,
      notes: ['EverythingMoe is an index of sites, not a direct media page.'],
    };
  }

  const episodePattern = detectEpisodePattern(url);
  if (episodePattern) return episodeRangeProbe(url, episodePattern);

  if (host === 'open.spotify.com' || host === 'spotify.com') {
    return {
      url,
      host,
      title: 'Spotify Track / Playlist',
      support: 'direct',
      itemCount: 1,
      preview: [{ title: 'Will search YouTube Music for match' }],
      isLive: false,
      notes: [
        'Direct Spotify capture is restricted by DRM.',
        'StreamDock will automatically search YouTube Music for the best matching audio version.',
      ],
    };
  }

  const manifestLikely = matchesHost(host, MANIFEST_PROBE_HOSTS());
  return {
    url,
    host,
    title: manifestLikely ? 'Stream page needs browser probe' : 'Metadata not available yet',
    support: manifestLikely ? 'manifest-probe' : 'unknown',
    itemCount: 1,
    preview: [{ title: manifestLikely ? 'Playable stream will be discovered at start' : 'Single URL' }],
    isLive: false,
    notes: [
      manifestLikely
        ? 'This host often hides HLS/DASH manifests behind the page player, so StreamDock will open a hidden probe when downloading.'
        : reason,
    ],
  };
}

function hasListParam(url: string): boolean {
  try {
    return new URL(url).searchParams.has('list');
  } catch {
    return false;
  }
}

interface ProbeResult {
  probe: PlaylistProbe | null;
  stdout: string;
  stderr: string;
}

function spawnProbe(
  url: string,
  flat: boolean,
  timeoutMs: number,
  ytDlpCmd?: { command: string; args: string[] },
): Promise<ProbeResult> {
  const resolvedCmd = ytDlpCmd ?? (() => {
    const path = resolveBinary('yt-dlp');
    return { command: path, args: [] };
  })();
  const args = [
    ...resolvedCmd.args,
    ...buildPluginDirArgs(),
    '--dump-single-json',
    ...(flat ? ['--flat-playlist'] : []),
    '--no-warnings',
    '--ignore-no-formats-error',
    '--skip-download',
    '--playlist-end',
    '500',
    '--',
    url,
  ];

  return new Promise((resolve) => {
    const child = spawn(resolvedCmd.command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (probe: PlaylistProbe | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ probe, stdout, stderr });
    };

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish(null);
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (settled) return;
      if (code === 0 && stdout.trim()) {
        finish(tryParse(url, stdout, stderr));
        return;
      }
      finish(null);
    });
  });
}

function tryParse(url: string, stdout: string, _stderr: string): PlaylistProbe | null {
  if (!stdout.trim()) return null;
  try {
    return parseInfo(url, stdout);
  } catch {
    return null;
  }
}

function isAnimeUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return ANIME_HOSTS().some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

function isPluginExtractorUrl(url: string): boolean {
  try {
    return matchesHost(hostFromUrl(url), PLUGIN_EXTRACTOR_HOSTS());
  } catch {
    return false;
  }
}

function shouldSkipYtDlpProbe(url: string): boolean {
  try {
    const host = hostFromUrl(url);
    return matchesHost(host, MANIFEST_PROBE_HOSTS()) && !isPluginExtractorUrl(url);
  } catch {
    return false;
  }
}

export async function inspectUrl(url: string): Promise<PlaylistProbe> {
  // Reference-index hosts (EverythingMoe and similar) must short-circuit here,
  // unconditionally and before any other check — previously this only worked
  // by coincidence (they also happened to match MANIFEST_PROBE_HOSTS below), and
  // fallbackProbe()'s own episode-pattern detection ran *before* its reference-host
  // check, so an episode-shaped EverythingMoe URL (e.g. .../anime/one-piece/episode-5)
  // slipped past the reference message entirely and was treated as real content.
  const refHost = hostFromUrl(url);
  if (matchesHost(refHost, REFERENCE_HOSTS())) {
    return await fallbackProbe(url, 'This page is a reference index, not a direct media source.');
  }

  if (shouldSkipYtDlpProbe(url)) {
    return await fallbackProbe(url, 'This page will be probed in a hidden browser when the download starts.');
  }

  // Known anime sites rely on bundled/local yt-dlp plugins. Prefer the bundled
  // binary so those plugins and bundled optional libraries are available.
  const useAnimeFork = isAnimeUrl(url);
  let ytDlpCmd: { command: string; args: string[] } | undefined;

  if (useAnimeFork) {
    try {
      ytDlpCmd = resolveYtDlpCommand(false);
    } catch {
      // Fall through to standard binary below
    }
  }

  // Fast pass: try with --flat-playlist first
  let result = await spawnProbe(url, true, PROBE_TIMEOUT_MS, ytDlpCmd);
  let probe = result.probe;

  // If the URL has a list= parameter but the probe returned only 1 entry
  // (common for YouTube radio mixes), retry without --flat-playlist
  if (
    probe &&
    probe.support === 'direct' &&
    (
      (hasListParam(url) && probe.preview.length <= 1) ||
      !probe.qualityOptions?.length
    )
  ) {
    result = await spawnProbe(url, false, FULL_PROBE_TIMEOUT_MS, ytDlpCmd);
    if (result.probe) probe = result.probe;
  }

  if (probe) return probe;
  return await fallbackProbe(url, result.stderr.trim() || 'The metadata probe failed. You can still try starting the download.');
}

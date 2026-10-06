// Role: safe metadata probe for single videos, playlists, and stream pages.
import type { BlockedKind, PlaylistProbe, PlaylistProbeItem, ProbeSupport, QualityOption } from '../shared/downloads';
import { buildPluginDirArgs, resolveYtDlpCommand } from './binary-resolver';
import { extractManifest, type ManifestResult } from './manifest-extractor';
import { fetchWithDeadline, removeTempFile, runProbeChild } from './probe-support';
import { EPISODE_PATTERNS, MANIFEST_PROBE_HOSTS, PLUGIN_EXTRACTOR_HOSTS, REFERENCE_HOSTS } from './url-router';

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
  /** Regex pulling the series id out of the page HTML, from host config. */
  seriesIdPattern?: string;
  /** Series endpoint with `{id}` substituted, from host config. */
  seriesApi?: string;
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
      seriesIdPattern: config.seriesIdPattern,
      seriesApi: config.seriesApi,
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

/**
 * Fetch a page as text, following redirects. Resolves to null on any failure.
 *
 * It had an idle timeout only — a server trickling bytes could hold it for
 * ever — and no handler for a response that died mid-body. The shared fetch
 * carries a total deadline and settles on every way a response can end.
 */
async function fetchPage(url: string, signal?: AbortSignal): Promise<string | null> {
  const { status, body } = await fetchWithDeadline(url, {
    timeoutMs: PAGE_FETCH_TIMEOUT_MS,
    signal,
    // Series metadata lives in the document head/meta block; no need to
    // buffer megabytes of episode-grid markup to find it.
    maxBytes: 512_000,
  });
  return status === 200 ? body : null;
}

/** Read the real episode total, series title and poster out of a series page. */
export function parseSeriesInfo(html: string): SeriesInfo {
  const info: SeriesInfo = {};

  // "Episodes: <span> 366</span>" and the common structured-data variants.
  //
  // The plural and the colon are both required. The previous pattern allowed
  // `Episodes?` with an optional colon, so on an *episode* page it matched
  //   Episode <span id="report-episode">1</span>
  // and read the current episode number as the series total — anikototv.to
  // reported "One Piece has 1 episodes", which is both false and silently
  // collapses the episode range to a single item.
  const totalMatch =
    html.match(/Episodes\s*:\s*(?:<\/?[a-z][^>]*>\s*)*(\d{1,5})\s*</i) ||
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

/**
 * Read a real episode count from the site's own series API.
 *
 * Some episode pages state no count at all — anikototv.to's states only the
 * episode you are looking at, which the old parser misread as the series
 * total. The page does carry the series id, and the site publishes a JSON API
 * keyed on it, so the count can be read as data instead of scraped.
 *
 * Best-effort by design: any failure returns undefined and the caller falls
 * back to listing only the pasted episode. A probe must never fail because a
 * count lookup did.
 */
export function parseSeriesApiCount(body: string): number | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return undefined;
  }

  const data = (payload as { data?: Record<string, unknown> })?.data;
  if (!data) return undefined;

  // A listed episode array is the most trustworthy answer: it is the episodes
  // that actually exist, not a number the site claims.
  const episodes = data.episodes;
  if (Array.isArray(episodes) && episodes.length > 0) return episodes.length;

  // Otherwise fall back to the per-language counts the series carries.
  const anime = data.anime as Record<string, unknown> | undefined;
  const counts = [anime?.is_sub, anime?.is_dub, anime?.episodes]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0 && value <= 10_000);

  return counts.length > 0 ? Math.max(...counts) : undefined;
}

async function resolveTotalFromSeriesApi(
  html: string,
  pattern: EpisodePattern,
  signal?: AbortSignal,
): Promise<number | undefined> {
  if (!pattern.seriesIdPattern || !pattern.seriesApi) return undefined;

  let idMatch: RegExpMatchArray | null;
  try {
    idMatch = html.match(new RegExp(pattern.seriesIdPattern, 'i'));
  } catch {
    return undefined;
  }

  const seriesId = idMatch?.[1];
  if (!seriesId) return undefined;

  const body = await fetchPage(pattern.seriesApi.replace('{id}', encodeURIComponent(seriesId)), signal);
  return body ? parseSeriesApiCount(body) : undefined;
}

async function episodeRangeProbe(url: string, pattern: EpisodePattern, signal?: AbortSignal): Promise<PlaylistProbe> {
  const html = await fetchPage(url, signal);
  signal?.throwIfAborted();
  const series = html ? parseSeriesInfo(html) : {};
  const seriesTitle = series.title || pattern.title;
  // Prefer a count the page states; otherwise ask the site's own series API.
  const total = series.totalEpisodes ?? (html ? await resolveTotalFromSeriesApi(html, pattern, signal) : undefined);
  signal?.throwIfAborted();

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

const BLOCKED_REASON: Record<Exclude<BlockedKind, 'drm'>, string> = {
  'reference-index': "This is an index of sites, not a video page. Open one of its listed sources, then paste that page's URL into StreamDock.",
  'no-media': 'No video found on this page. No downloader recognises the site, and its player loaded no stream while StreamDock watched. If the page does play video, press Analyze again — its player may have been slow to start.',
  encrypted: 'This video stream is encrypted in a way only its own player can read, so it cannot be downloaded.',
};

function blockedProbe(url: string, blocked: BlockedKind, reason: string): PlaylistProbe {
  return {
    url,
    host: hostFromUrl(url),
    title: 'This page cannot be downloaded',
    support: 'unsupported',
    blocked,
    itemCount: 0,
    preview: [],
    isLive: false,
    notes: [reason],
  };
}

/**
 * A page whose stream the hidden browser finds at start.
 *
 * The renderer names a single-item download after its preview item, so without
 * the page's own title the file is saved as the placeholder text itself.
 * ponytail: listed probe hosts are never opened at probe time, so a single page
 * on one still gets the placeholder name; reading the title there is the upgrade.
 */
function manifestProbe(url: string, note: string, pageTitle?: string, stream?: PlaylistProbe['stream']): PlaylistProbe {
  return {
    url,
    host: hostFromUrl(url),
    title: pageTitle ?? 'Stream page needs browser probe',
    support: 'manifest-probe',
    itemCount: 1,
    preview: [{ title: pageTitle ?? 'Playable stream will be discovered at start' }],
    isLive: false,
    notes: [note],
    stream,
  };
}

/** Why a playlist cannot be downloaded, when it says so itself. */
export type StreamProtection = { kind: 'encrypted' } | { kind: 'drm'; systems: string[] };

/** DRM systems by the key formats and scheme ids playlists declare them with. */
const DRM_SYSTEMS: Array<[string, RegExp]> = [
  ['FairPlay', /com\.apple\.streamingkeydelivery|skd:\/\/|94ce86fb-07ff-4f43-adb8-93d2fa968ca2/i],
  ['Widevine', /edef8ba9-79d6-4ace-a3c8-27dcd51d21ed/i],
  ['PlayReady', /com\.microsoft\.playready|9a04f079-9840-4286-ab92-e65be0885f95/i],
];

/**
 * What a fetched playlist declares about its own protection.
 *
 * - Neither a playlist nor markup (HLS starts with #EXTM3U, DASH is XML, a
 *   block page is HTML): a playlist only the page's script can read. Measured
 *   on one embed provider, whose playlists are ciphertext even with the
 *   player's referer and whose segments are a PNG signature then encrypted
 *   bytes; yt-dlp calls it "Response data has no m3u header".
 * - An HLS key with SAMPLE-AES or a key format other than "identity", or any
 *   DASH ContentProtection: DRM, which yt-dlp refuses at download.
 * - Standard AES-128 is neither. The playlist points at its own key, and the
 *   lab's AES-128 fixture downloads and decodes to the source's frames.
 */
export function manifestProtection(body: string | null): StreamProtection | null {
  const text = (body ?? '').trimStart();
  if (text === '') return null;
  if (!text.startsWith('#EXTM3U') && !text.startsWith('<')) return { kind: 'encrypted' };
  const drmKeys = (text.match(/^#EXT-X-(?:SESSION-)?KEY:.*$/gm) ?? [])
    .filter((key) => /METHOD=SAMPLE-AES/i.test(key) || /KEYFORMAT="(?!identity")/i.test(key));
  const dashProtection = text.match(/<ContentProtection\b[^>]*>/gi) ?? [];
  const evidence = [...drmKeys, ...dashProtection];
  if (evidence.length === 0) return null;
  return { kind: 'drm', systems: DRM_SYSTEMS.filter(([, pattern]) => evidence.some((e) => pattern.test(e))).map(([name]) => name) };
}

/** The first variant a master playlist lists, as an absolute URL; null for a media playlist. */
export function firstVariantUrl(master: string, base: string): string | null {
  const lines = master.split(/\r?\n/).map((line) => line.trim());
  const at = lines.findIndex((line) => line.startsWith('#EXT-X-STREAM-INF'));
  const uri = at === -1 ? undefined : lines.slice(at + 1).find((line) => line && !line.startsWith('#'));
  if (!uri) return null;
  try {
    return new URL(uri, base).toString();
  } catch {
    return null;
  }
}

/**
 * Fetch the stream the way its player did — same referer, same cookies — and
 * read what it declares. A master playlist usually leaves the key to its
 * variants, so the first variant is read too when the master declares nothing.
 * A stream that refuses the check cannot be judged and is left downloadable:
 * the engine resolves the page again at start, in its own browser session.
 */
async function streamProtection(found: ManifestResult, signal?: AbortSignal): Promise<StreamProtection | null> {
  const headers: Record<string, string> = {};
  if (found.referer) headers.Referer = found.referer;
  if (found.cookieHeader) headers.Cookie = found.cookieHeader;
  const read = async (url: string) => {
    const { status, body } = await fetchWithDeadline(url, { headers, timeoutMs: PAGE_FETCH_TIMEOUT_MS, signal, maxBytes: 64_000 });
    signal?.throwIfAborted();
    return status === 200 ? body : null;
  };

  const master = await read(found.manifestUrl);
  if (master === null) return null;
  const declared = manifestProtection(master);
  const variant = declared || found.type !== 'm3u8' ? null : firstVariantUrl(master, found.manifestUrl);
  if (!variant) return declared;
  const media = await read(variant);
  return media === null ? null : manifestProtection(media);
}

/**
 * No extractor claims this page, so look for its stream the way a browser
 * extension does: load it in the hidden probe window and watch what its player
 * requests, iframes and embeds included.
 *
 * That window used to open only for hosts listed in host-config, so every site
 * outside the list — however plain its player — failed as "Unsupported URL"
 * until someone added its domain by hand. What it finds is checked once for
 * protection; the engine resolves the page again at start, because stream
 * tokens expire.
 */
async function findStreamInPage(url: string, signal?: AbortSignal): Promise<PlaylistProbe> {
  const found = await extractManifest(url, undefined, signal);
  removeTempFile(found?.cookiesFile);
  signal?.throwIfAborted();
  if (!found) return blockedProbe(url, 'no-media', BLOCKED_REASON['no-media']);

  const protection = found.type === 'mp4' ? null : await streamProtection(found, signal);
  if (protection?.kind === 'encrypted') return blockedProbe(url, 'encrypted', BLOCKED_REASON.encrypted);
  if (protection?.kind === 'drm') {
    const system = protection.systems.length > 0 ? `${protection.systems.join(' and ')} DRM` : 'DRM';
    return blockedProbe(url, 'drm', `This video is protected by ${system}, so it cannot be downloaded.`);
  }

  return manifestProbe(
    url,
    'No extractor supports this site, but its player loads a stream StreamDock can read. The page will be opened again in a hidden browser when the download starts.',
    found.pageTitle,
    { url: found.manifestUrl, referer: found.referer },
  );
}

async function fallbackProbe(url: string, reason: string, signal?: AbortSignal, noExtractor = false): Promise<PlaylistProbe> {
  const host = hostFromUrl(url);
  if (matchesHost(host, REFERENCE_HOSTS())) {
    // Never downloadable, and engine.start() refuses it — so the probe says so
    // too, rather than 'unknown' with the Download button still enabled.
    return { ...blockedProbe(url, 'reference-index', BLOCKED_REASON['reference-index']), title: 'EverythingMoe reference index' };
  }

  const episodePattern = detectEpisodePattern(url);
  if (episodePattern) return episodeRangeProbe(url, episodePattern, signal);

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

  if (matchesHost(host, MANIFEST_PROBE_HOSTS())) {
    return manifestProbe(url, 'This host often hides HLS/DASH manifests behind the page player, so StreamDock will open a hidden probe when downloading.');
  }
  if (noExtractor) return findStreamInPage(url, signal);

  // The probe failed for some other reason — a timeout, a network error, a
  // 403 — which says nothing about whether the download itself can work.
  return {
    url,
    host,
    title: 'Metadata not available yet',
    support: 'unknown',
    itemCount: 1,
    preview: [{ title: 'Single URL' }],
    isLive: false,
    notes: [reason],
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
  stderr: string;
}

async function spawnProbe(
  url: string,
  flat: boolean,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ProbeResult> {
  // The bundled binary loads the bundled plugins through --plugin-dirs, anime
  // hosts included; the "anime fork" branch that used to pick it resolved to
  // this same binary.
  const resolvedCmd = resolveYtDlpCommand();
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

  const { code, stdout, stderr } = await runProbeChild(resolvedCmd.command, args, { timeoutMs, signal });
  return { probe: code === 0 ? tryParse(url, stdout) : null, stderr };
}

function tryParse(url: string, stdout: string): PlaylistProbe | null {
  if (!stdout.trim()) return null;
  try {
    return parseInfo(url, stdout);
  } catch {
    return null;
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

/**
 * The last verdict the probe reached for each URL, which is what engine.start()
 * enforces. Only the verdict is kept, not the probe and its preview list.
 */
const verdicts = new Map<string, { support: ProbeSupport; reason: string }>();

export function probeVerdict(url: string): { support: ProbeSupport; reason: string } | undefined {
  return verdicts.get(url);
}

/**
 * Describe what a URL holds. Rejects with the signal's reason when `signal`
 * aborts, after stopping any yt-dlp probe it started.
 */
export async function inspectUrl(url: string, signal?: AbortSignal): Promise<PlaylistProbe> {
  const probe = await describeUrl(url, signal);
  verdicts.set(url, { support: probe.support, reason: probe.notes[0] ?? '' });
  return probe;
}

async function describeUrl(url: string, signal?: AbortSignal): Promise<PlaylistProbe> {
  signal?.throwIfAborted();
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
    return await fallbackProbe(url, 'This page will be probed in a hidden browser when the download starts.', signal);
  }

  // Fast pass: try with --flat-playlist first
  let result = await spawnProbe(url, true, PROBE_TIMEOUT_MS, signal);
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
    result = await spawnProbe(url, false, FULL_PROBE_TIMEOUT_MS, signal);
    if (result.probe) probe = result.probe;
  }

  if (probe) return probe;
  // yt-dlp's verdict when no extractor claims the URL and its generic one found
  // no media in the page's HTML — distinct from a probe that merely failed.
  const noExtractor = /\bUnsupported URL\b/i.test(result.stderr);
  return await fallbackProbe(url, result.stderr.trim() || 'The metadata probe failed. You can still try starting the download.', signal, noExtractor);
}

// Role: authoritative main-process URL analysis and mode suggestion.
// The host lists are bundled into the main-process build rather than read from
// disk at runtime. The runtime read looked for resources/electron/host-config.json,
// which electron-builder never packaged: every installed build silently ran on a
// hand-maintained fallback copy in this file, and edits to the JSON only ever
// took effect in dev. One import, one source, no fallback to drift.
import hostConfigJson from './host-config.json';

export type CaptureMode = 'video' | 'stream';

export interface UrlAnalysis {
  url: string;
  host: string;
  valid: boolean;
  suggestedMode: CaptureMode;
  reason: string;
}

/**
 * How a host numbers its episodes, expressed as data rather than code.
 *
 * `pathPattern` is matched against the URL path and must expose a `series`
 * named group; it may also expose an `episode` group. Exactly one of
 * `episodeParam` (the episode number lives in a query parameter) or `nextPath`
 * (it lives in the path, and this template rebuilds it) says where the number
 * is and how to walk to the next one.
 *
 * Hosts used to be matched by literal regex inside playlist-inspector, which is
 * why anikototv.to never resolved: it is listed in every host array here and
 * shares anikoto.cz's URL shape exactly, but only anikoto.cz was written into
 * that function.
 */
export interface EpisodePatternConfig {
  hosts: string[];
  pathPattern: string;
  episodeParam?: string;
  nextPath?: string;
  titlePrefix?: string;
  /** Regex with one capture group pulling the series id out of the page HTML. */
  seriesIdPattern?: string;
  /** Endpoint returning the series, with `{id}` substituted. Used to read a
   *  real episode count when the page itself states none. */
  seriesApi?: string;
}

/** Download concurrency for hosts the engine must be gentle with. */
export interface ConcurrencyConfig {
  /** Most downloads at once from any one manifest-probe host (anime CDNs). */
  probeHostMaxConcurrent: number;
  /** Least time between two download starts on the same host. */
  startSpacingMs: number;
}

interface HostConfig {
  streamHosts: string[];
  referenceHosts: string[];
  pluginExtractorHosts: string[];
  manifestProbeHosts: string[];
  animeHosts: string[];
  ytDlpSupportedHosts: string[];
  episodePatterns?: EpisodePatternConfig[];
  concurrency: ConcurrencyConfig;
}

const hostConfig: HostConfig = hostConfigJson;

function loadHostConfig(): HostConfig {
  return hostConfig;
}

export const STREAM_HOSTS = () => loadHostConfig().streamHosts;
export const REFERENCE_HOSTS = () => loadHostConfig().referenceHosts;
export const PLUGIN_EXTRACTOR_HOSTS = () => loadHostConfig().pluginExtractorHosts;
export const MANIFEST_PROBE_HOSTS = () => loadHostConfig().manifestProbeHosts;
export const ANIME_HOSTS = () => loadHostConfig().animeHosts;
export const YTDLP_SUPPORTED_HOSTS = () => loadHostConfig().ytDlpSupportedHosts;
export const EPISODE_PATTERNS = (): EpisodePatternConfig[] => loadHostConfig().episodePatterns ?? [];
export const CONCURRENCY = (): ConcurrencyConfig => loadHostConfig().concurrency;

function matchesHost(host: string, domains: string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function analyzeUrl(value: string): UrlAnalysis {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('Enter a valid URL that starts with http:// or https://.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https URLs are supported.');
  }

  const url = parsed.toString();
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const lower = url.toLowerCase();

  if (lower.includes('.m3u8') || lower.includes('.mpd')) {
    return { url, host, valid: true, suggestedMode: 'stream', reason: 'Manifest URL detected.' };
  }

  if (matchesHost(host, REFERENCE_HOSTS())) {
    return {
      url,
      host,
      valid: true,
      suggestedMode: 'video',
      reason: 'Reference index detected. Open a listed source page, then paste that source URL into StreamDock.',
    };
  }

  if (matchesHost(host, STREAM_HOSTS())) {
    return { url, host, valid: true, suggestedMode: 'stream', reason: 'Known live streaming host.' };
  }

  if (matchesHost(host, PLUGIN_EXTRACTOR_HOSTS())) {
    return {
      url,
      host,
      valid: true,
      suggestedMode: 'video',
      reason: 'Plugin-backed media page detected. StreamDock will attempt direct API/manifest extraction first, then fall back to yt-dlp plugins.',
    };
  }

  if (matchesHost(host, MANIFEST_PROBE_HOSTS())) {
    return {
      url,
      host,
      valid: true,
      suggestedMode: 'stream',
      reason: 'This stream page will be probed for a manifest before capture.',
    };
  }

  if (host === 'open.spotify.com' || host === 'spotify.com') {
    return {
      url,
      host,
      valid: true,
      suggestedMode: 'video',
      reason: 'Spotify DRM prevents direct capture. StreamDock will search YouTube Music for this track.',
    };
  }

  if ((host === 'youtube.com' || host.endsWith('.youtube.com')) && parsed.pathname.includes('/live')) {
    return { url, host, valid: true, suggestedMode: 'stream', reason: 'YouTube live URL detected.' };
  }

  return { url, host, valid: true, suggestedMode: 'video', reason: 'Standard media URL.' };
}

export function getProbeStrategy(url: string): 'ytdlp' | 'browser' {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (matchesHost(host, YTDLP_SUPPORTED_HOSTS())) {
      return 'ytdlp';
    }
    return 'browser';
  } catch {
    return 'browser';
  }
}
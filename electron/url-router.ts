// Role: authoritative main-process URL analysis and mode suggestion.
import { readFileSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';

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
}

interface HostConfig {
  streamHosts: string[];
  referenceHosts: string[];
  pluginExtractorHosts: string[];
  manifestProbeHosts: string[];
  animeHosts: string[];
  ytDlpSupportedHosts: string[];
  episodePatterns?: EpisodePatternConfig[];
}

let configCache: HostConfig | null = null;

function loadHostConfig(): HostConfig {
  if (configCache) return configCache;

  // Path resolution itself (app.getAppPath() / process.resourcesPath) used to sit
  // outside the try/catch below, so if either was unavailable — e.g. app not yet
  // ready, or a restricted/mocked runtime — this threw instead of falling back to
  // the hardcoded defaults the catch block promises. Everything now goes through
  // one try/catch so ANY failure to obtain a usable config falls back safely.
  try {
    const isDev = !app.isPackaged || process.env.NODE_ENV === 'development';
    const configPath = isDev
      ? join(app.getAppPath(), 'electron', 'host-config.json')
      : join(process.resourcesPath, 'electron', 'host-config.json');
    const content = readFileSync(configPath, 'utf-8');
    configCache = JSON.parse(content) as HostConfig;
    return configCache;
  } catch {
    // Fallback to hardcoded defaults if config file not found
    configCache = {
      streamHosts: ['twitch.tv', 'kick.com', 'trovo.live', 'afreecatv.com', 'movies-central.com', 'supernova.to'],
      referenceHosts: ['everythingmoe.com', 'everythingmoe.org'],
      pluginExtractorHosts: ['anikoto.cz', 'anikototv.to', 'animepahe.com', 'animepahe.pw', 'animepahe.org', 'aniwatchtv.to', 'kaido.to'],
      manifestProbeHosts: ['anikoto.cz', 'anidap.se', 'animedao.watch', 'anikototv.to', 'shuttletv.su', 'gojoora.com', 'gojoora.net', 'movies-central.com', 'supernova.to', 'hianime.to', 'hianime.com', 'hianime.re', 'aniwatch.to', 'aniwatch.com', 'fmovies.to', 'fmovies.ps', 'fmovies.wtf'],
      animeHosts: ['anikoto.cz', 'anidap.se', 'animedao.watch', 'anikototv.to', 'animepahe.com', 'animepahe.pw', 'animepahe.org', 'aniwatchtv.to', 'kaido.to', 'hianime.to', 'hianime.com', 'hianime.re', 'aniwatch.to', 'aniwatch.com', 'gojoora.com', 'gojoora.net'],
      ytDlpSupportedHosts: ['youtube.com', 'youtu.be', 'vimeo.com', 'tiktok.com', 'instagram.com', 'twitter.com', 'x.com', 'twitch.tv'],
      episodePatterns: [
        { hosts: ['shuttletv.su'], pathPattern: '^/watch/(?<series>[^/]+)', episodeParam: 'e', titlePrefix: 'ShuttleTV' },
        { hosts: ['anikoto.cz', 'anikototv.to'], pathPattern: '^/watch/(?<series>[^/]+)/ep-(?<episode>\\d+)$', nextPath: '/watch/{series}/ep-{episode}' },
      ],
    };
    return configCache;
  }
}

export const STREAM_HOSTS = () => loadHostConfig().streamHosts;
export const REFERENCE_HOSTS = () => loadHostConfig().referenceHosts;
export const PLUGIN_EXTRACTOR_HOSTS = () => loadHostConfig().pluginExtractorHosts;
export const MANIFEST_PROBE_HOSTS = () => loadHostConfig().manifestProbeHosts;
export const ANIME_HOSTS = () => loadHostConfig().animeHosts;
export const YTDLP_SUPPORTED_HOSTS = () => loadHostConfig().ytDlpSupportedHosts;
export const EPISODE_PATTERNS = (): EpisodePatternConfig[] => loadHostConfig().episodePatterns ?? [];

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
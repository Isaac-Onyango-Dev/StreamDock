// Role: authoritative main-process URL analysis and mode suggestion.

export type CaptureMode = 'video' | 'stream';

export interface UrlAnalysis {
  url: string;
  host: string;
  valid: boolean;
  suggestedMode: CaptureMode;
  reason: string;
}

export const STREAM_HOSTS = ['twitch.tv', 'kick.com', 'trovo.live', 'afreecatv.com', 'movies-central.com', 'supernova.to'];
export const REFERENCE_HOSTS = ['everythingmoe.com', 'everythingmoe.org'];
export const PLUGIN_EXTRACTOR_HOSTS = [
  'anikoto.cz',
  'anikototv.to',
  'animepahe.com',
  'animepahe.pw',
  'animepahe.org',
  'aniwatchtv.to',
  'kaido.to',
];
export const MANIFEST_PROBE_HOSTS = [
  ...REFERENCE_HOSTS,
  'anikoto.cz',
  'anidap.se',
  'animedao.watch',
  'anikototv.to',
  'shuttletv.su',
  'gojoora.com',
  'gojoora.net',
  'movies-central.com',
  'supernova.to',
  // hianime variants — in ANIME_HOSTS but also need manifest probe fallback
  'hianime.to',
  'hianime.com',
  'hianime.re',
  'aniwatch.to',
  'aniwatch.com',
  // fmovies variants
  'fmovies.to',
  'fmovies.ps',
  'fmovies.wtf',
];

/**
 * Anime-oriented hosts that should use the bundled/local plugin path where possible.
 */
export const ANIME_HOSTS = [
  ...PLUGIN_EXTRACTOR_HOSTS,
  'anikoto.cz',
  'anidap.se',
  'animedao.watch',
  'anikototv.to',
  'animepahe.com',
  'animepahe.pw',
  'animepahe.org',
  'aniwatchtv.to',
  'kaido.to',
  'hianime.to',
  'hianime.com',
  'hianime.re',
  'aniwatch.to',
  'aniwatch.com',
  'gojoora.com',
  'gojoora.net',
  ...REFERENCE_HOSTS,
].filter((host, index, list) => list.indexOf(host) === index);

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

  if (matchesHost(host, REFERENCE_HOSTS)) {
    return {
      url,
      host,
      valid: true,
      suggestedMode: 'video',
      reason: 'Reference index detected. Open a listed source page, then paste that source URL into StreamDock.',
    };
  }

  if (matchesHost(host, STREAM_HOSTS)) {
    return { url, host, valid: true, suggestedMode: 'stream', reason: 'Known live streaming host.' };
  }

  if (matchesHost(host, PLUGIN_EXTRACTOR_HOSTS)) {
    return {
      url,
      host,
      valid: true,
      suggestedMode: 'video',
      reason: 'Plugin-backed media page detected. StreamDock will attempt direct API/manifest extraction first, then fall back to yt-dlp plugins.',
    };
  }

  if (matchesHost(host, MANIFEST_PROBE_HOSTS)) {
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

// Role: safe metadata probe for single videos, playlists, and stream pages.
import { spawn } from 'child_process';
import { buildPluginDirArgs, resolveBinary, resolveYtDlpCommand } from './binary-resolver';
import { ANIME_HOSTS, MANIFEST_PROBE_HOSTS, PLUGIN_EXTRACTOR_HOSTS, REFERENCE_HOSTS } from './url-router';

export type ProbeSupport = 'direct' | 'playlist' | 'episode-range' | 'manifest-probe' | 'unknown';

export interface PlaylistProbeItem {
  id?: string;
  title: string;
  url?: string;
  duration?: number;
  thumbnail?: string;
}

export interface PlaylistProbe {
  url: string;
  host: string;
  title: string;
  support: ProbeSupport;
  itemCount: number;
  preview: PlaylistProbeItem[];
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
  duration?: number;
  thumbnail?: string;
  entries?: Array<YtDlpInfo | null>;
}

const PROBE_TIMEOUT_MS = 25_000;
const FULL_PROBE_TIMEOUT_MS = 60_000;
const PREVIEW_LIMIT = 200;

interface EpisodePattern {
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

function toItem(entry: YtDlpInfo | null, index: number): PlaylistProbeItem {
  return {
    id: entry?.id,
    title: entry?.title || `Episode ${index + 1}`,
    url: entry?.webpage_url || entry?.url,
    duration: entry?.duration,
    thumbnail: entry?.thumbnail,
  };
}

function cleanSeries(value: string): string {
  return value
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function detectEpisodePattern(rawUrl: string): EpisodePattern | null {
  const parsed = new URL(rawUrl);
  const host = hostFromUrl(rawUrl);
  const path = parsed.pathname;

  if (matchesHost(host, ['shuttletv.su']) && path.startsWith('/watch/')) {
    const episode = Number(parsed.searchParams.get('e'));
    if (Number.isFinite(episode) && episode > 0) {
      const title = `ShuttleTV ${path.split('/').filter(Boolean).at(-1) || 'show'}`;
      return {
        title,
        currentEpisode: episode,
        createUrl: (nextEpisode) => {
          const next = new URL(rawUrl);
          next.searchParams.set('e', String(nextEpisode));
          return next.toString();
        },
      };
    }
  }

  const anikotoMatch = path.match(/^\/watch\/([^/]+)\/ep-(\d+)$/i);
  if (matchesHost(host, ['anikoto.cz']) && anikotoMatch) {
    const series = cleanSeries(anikotoMatch[1]);
    const episode = Number(anikotoMatch[2]);
    return {
      title: series,
      currentEpisode: episode,
      createUrl: (nextEpisode) => `${parsed.origin}/watch/${anikotoMatch[1]}/ep-${nextEpisode}`,
    };
  }

  return null;
}

function episodeRangeProbe(url: string, pattern: EpisodePattern): PlaylistProbe {
  const start = pattern.currentEpisode;
  const preview = Array.from({ length: PREVIEW_LIMIT }, (_, index) => {
    const episode = start + index;
    return {
      id: String(episode),
      title: `${pattern.title} - Episode ${episode}`,
      url: pattern.createUrl(episode),
    };
  });

  return {
    url,
    host: hostFromUrl(url),
    title: pattern.title,
    support: 'episode-range',
    itemCount: 999,
    preview,
    isLive: false,
    notes: [
      `Episode pattern detected at episode ${pattern.currentEpisode}. Choose First or Range to queue generated episode URLs.`,
      'StreamDock will still use browser manifest probing for each episode page.',
    ],
  };
}

function parseInfo(url: string, stdout: string): PlaylistProbe {
  const info = JSON.parse(stdout) as YtDlpInfo;
  const host = hostFromUrl(url);
  const entries = Array.isArray(info.entries) ? info.entries.filter(Boolean) : [];
  const itemCount = entries.length || 1;
  const support: ProbeSupport = entries.length > 1 ? 'playlist' : 'direct';

  return {
    url: info.webpage_url || info.original_url || url,
    host,
    title: info.title || (entries.length > 1 ? 'Detected playlist' : 'Detected media'),
    support,
    itemCount,
    preview: entries.length > 0 ? entries.slice(0, PREVIEW_LIMIT).map(toItem) : [toItem(info, 0)],
    thumbnail: info.thumbnail,
    extractor: info.extractor_key || info.extractor,
    isLive: info.live_status === 'is_live',
    notes: [
      entries.length > PREVIEW_LIMIT
        ? `Showing first ${PREVIEW_LIMIT} of ${entries.length} detected items.`
        : 'Metadata probe completed.',
    ],
  };
}

function fallbackProbe(url: string, reason: string): PlaylistProbe {
  const episodePattern = detectEpisodePattern(url);
  if (episodePattern) return episodeRangeProbe(url, episodePattern);

  const host = hostFromUrl(url);
  if (matchesHost(host, REFERENCE_HOSTS)) {
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

  const manifestLikely = matchesHost(host, MANIFEST_PROBE_HOSTS);
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

function tryParse(url: string, stdout: string, stderr: string): PlaylistProbe | null {
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
    return ANIME_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

function isPluginExtractorUrl(url: string): boolean {
  try {
    return matchesHost(hostFromUrl(url), PLUGIN_EXTRACTOR_HOSTS);
  } catch {
    return false;
  }
}

function shouldSkipYtDlpProbe(url: string): boolean {
  try {
    const host = hostFromUrl(url);
    return matchesHost(host, MANIFEST_PROBE_HOSTS) && !isPluginExtractorUrl(url);
  } catch {
    return false;
  }
}

export async function inspectUrl(url: string): Promise<PlaylistProbe> {
  if (shouldSkipYtDlpProbe(url)) {
    return fallbackProbe(url, 'This page will be probed in a hidden browser when the download starts.');
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
    hasListParam(url) &&
    probe.preview.length <= 1
  ) {
    result = await spawnProbe(url, false, FULL_PROBE_TIMEOUT_MS, ytDlpCmd);
    if (result.probe) probe = result.probe;
  }

  if (probe) return probe;
  return fallbackProbe(url, result.stderr.trim() || 'The metadata probe failed. You can still try starting the download.');
}

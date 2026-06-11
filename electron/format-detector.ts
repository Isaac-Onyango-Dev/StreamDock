// Role: automatic media format detection from URL — no user configuration required.

export type MediaFormat =
  | 'hls'       // HLS (.m3u8)
  | 'dash'      // DASH (.mpd)
  | 'mp4'       // Direct MP4
  | 'mkv'       // Direct MKV
  | 'webm'      // Direct WebM
  | 'fmp4'      // Fragmented MP4 (detected by URL pattern or Content-Type)
  | 'audio'     // Audio-only (mp3, m4a, opus, flac, wav)
  | 'live'      // Live stream (twitch, youtube/live, etc.)
  | 'unknown';  // Let yt-dlp figure it out

export interface FormatDetection {
  format: MediaFormat;
  isLive: boolean;
  requiresRange: boolean;  // True for direct files — use range-request acceleration
  liveMessage?: string;    // Human-readable message for live streams
}

const LIVE_HOSTS = [
  'twitch.tv', 'kick.com', 'trovo.live', 'afreecatv.com',
  'youtube.com', 'youtu.be',
];

const LIVE_PATH_PATTERNS = ['/live', '/stream', '/live_stream'];

export function detectFormat(url: string): FormatDetection {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { format: 'unknown', isLive: false, requiresRange: false };
  }

  const lower = url.toLowerCase();
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const path = parsed.pathname.toLowerCase();

  // ── Manifest formats ────────────────────────────────────────────────────────
  if (lower.includes('.m3u8') || lower.includes('/hls/') || lower.includes('/playlist.m3u8')) {
    return { format: 'hls', isLive: false, requiresRange: false };
  }
  if (lower.includes('.mpd') || lower.includes('/dash/') || lower.includes('manifest.mpd')) {
    return { format: 'dash', isLive: false, requiresRange: false };
  }

  // ── Direct file formats ──────────────────────────────────────────────────────
  if (path.endsWith('.mp4') || lower.includes('.mp4?')) {
    return { format: 'mp4', isLive: false, requiresRange: true };
  }
  if (path.endsWith('.mkv') || lower.includes('.mkv?')) {
    return { format: 'mkv', isLive: false, requiresRange: true };
  }
  if (path.endsWith('.webm') || lower.includes('.webm?')) {
    return { format: 'webm', isLive: false, requiresRange: true };
  }
  if (path.endsWith('.mp3') || path.endsWith('.m4a') || path.endsWith('.opus') ||
      path.endsWith('.flac') || path.endsWith('.wav') || path.endsWith('.aac')) {
    return { format: 'audio', isLive: false, requiresRange: true };
  }

  // ── Fragmented MP4 (fMP4) detection ─────────────────────────────────────────
  if (lower.includes('/fragment') || lower.includes('/seg') || lower.includes('fmp4') ||
      lower.includes('/init.mp4') || lower.includes('segment_duration')) {
    return { format: 'fmp4', isLive: false, requiresRange: false };
  }

  // ── Live stream hosts ────────────────────────────────────────────────────────
  const isLiveHost = LIVE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  const isLivePath = LIVE_PATH_PATTERNS.some((p) => path.includes(p));
  const isYouTubeLive =
    (host === 'youtube.com' || host.endsWith('.youtube.com')) &&
    (path.includes('/live') || parsed.searchParams.has('v'));

  if (isLiveHost && (isLivePath || host.includes('twitch') || host.includes('kick'))) {
    return {
      format: 'live',
      isLive: true,
      requiresRange: false,
      liveMessage: 'Live stream detected — recording mode active.',
    };
  }

  if (isYouTubeLive && path.includes('/live')) {
    return {
      format: 'live',
      isLive: true,
      requiresRange: false,
      liveMessage: 'YouTube Live detected — recording from start.',
    };
  }

  return { format: 'unknown', isLive: false, requiresRange: false };
}

/** Build yt-dlp arguments specific to the detected format. */
export function buildFormatArgs(detection: FormatDetection, quality?: string): string[] {
  const args: string[] = [];

  switch (detection.format) {
    case 'hls':
      // yt-dlp handles HLS natively including AES-128 decryption
      args.push('--hls-use-mpegts', '--hls-prefer-native');
      if (quality) args.push('-f', quality);
      else args.push('-f', 'bestvideo+bestaudio/best');
      break;

    case 'dash':
      // yt-dlp handles DASH natively including multi-bitrate selection
      if (quality) args.push('-f', quality);
      else args.push('-f', 'bestvideo+bestaudio/best');
      args.push('--merge-output-format', 'mp4');
      break;

    case 'mp4':
    case 'mkv':
    case 'webm':
      // Direct file — use concurrent connections for speed
      if (quality) args.push('-f', quality);
      else args.push('-f', 'bestvideo+bestaudio/best');
      args.push('--concurrent-fragments', '4');
      break;

    case 'fmp4':
      // Fragmented MP4 — ensure init segment is captured
      if (quality) args.push('-f', quality);
      else args.push('-f', 'bestvideo+bestaudio/best');
      args.push('--hls-use-mpegts');
      break;

    case 'audio':
      args.push('-f', 'bestaudio/best');
      args.push('-x', '--audio-format', 'mp3');
      break;

    case 'live':
      // Live recording
      args.push('--live-from-start', '--hls-use-mpegts');
      if (quality) args.push('-f', quality);
      else args.push('-f', 'best');
      break;

    default:
      // Unknown — let yt-dlp decide
      if (quality) args.push('-f', quality);
      else args.push('-f', 'bestvideo+bestaudio/best');
      args.push('--merge-output-format', 'mp4');
      break;
  }

  return args;
}

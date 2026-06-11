// Role: user-facing error translation — ALL internal errors must pass through here.
// Users must NEVER see: stack traces, file paths, raw yt-dlp stderr, or internal details.
import log from 'electron-log';

/** Redact file-system paths and anything that looks like a credential from raw text. */
function sanitizeRaw(raw: string): string {
  return raw
    // Windows absolute paths: C:\Users\...
    .replace(/[A-Za-z]:\\[^\s"']+/g, '[path]')
    // Unix absolute paths: /home/... /usr/... /tmp/...
    .replace(/\/(?:home|usr|tmp|var|opt|etc|root|mnt|media)[^\s"']*/g, '[path]')
    // Cookies / tokens / passwords
    .replace(/cookie[s]?\s*[=:][^\n]*/gi, 'cookie=[REDACTED]')
    .replace(/password\s*[=:][^\n]*/gi, 'password=[REDACTED]')
    .replace(/token\s*[=:][^\n]*/gi, 'token=[REDACTED]')
    .replace(/authorization\s*[=:][^\n]*/gi, 'authorization=[REDACTED]')
    // Stack trace lines
    .replace(/\s+at\s+\S+\s+\(\S+\)/g, '')
    .replace(/\s+at\s+\S+/g, '');
}

/**
 * Classify a raw error string into a structured category.
 * Returns the user-facing message and logs the raw error internally.
 */
export function toUserError(error: unknown, fallback = 'Something went wrong. Retry or report this.'): string {
  const raw = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error ?? fallback);
  const lower = raw.toLowerCase();

  // Log full technical detail internally — never surfaces to UI
  log.debug('[error-translator] Raw error:', sanitizeRaw(raw).substring(0, 500));

  // ── Binary / engine missing ──────────────────────────────────────────────────
  if (lower.includes('enoent') && (lower.includes('yt-dlp') || lower.includes('ffmpeg'))) {
    return 'The download engine is missing. Add yt-dlp and ffmpeg to the binaries folder or system PATH.';
  }
  if (lower.includes('enoent') || lower.includes('spawn')) {
    return 'A required program could not be started. Check that yt-dlp and ffmpeg are installed.';
  }
  if (lower.includes('yt-dlp') && lower.includes('error:') && lower.includes('invalid')) {
    return 'The download engine rejected one of StreamDock\'s options. Please update StreamDock or report this.';
  }

  // ── Network errors ───────────────────────────────────────────────────────────
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('etimedout')) {
    return 'Connection timed out. Check your internet connection.';
  }
  if (
    lower.includes('getaddrinfo') ||
    lower.includes('enotfound') ||
    lower.includes('dns') ||
    lower.includes('name or service not known')
  ) {
    return 'Could not reach the server. Check your connection.';
  }
  if (
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('socket hang up') ||
    (lower.includes('network') && lower.includes('error'))
  ) {
    return 'The network connection failed. Check your internet and retry.';
  }

  // ── HTTP error codes ─────────────────────────────────────────────────────────
  if (lower.match(/\b429\b/) || lower.includes('too many requests') || lower.includes('rate limit')) {
    return 'Rate limited. Waiting before retrying…';
  }
  if (
    lower.match(/\b403\b/) ||
    lower.includes('forbidden') ||
    lower.includes('login required') ||
    lower.includes('sign in') ||
    lower.includes('private') ||
    lower.includes('authentication')
  ) {
    return 'This content requires a login. Please log in on the site first.';
  }
  if (lower.match(/\b401\b/)) {
    return 'This content requires a login.';
  }
  if (lower.match(/\b404\b/) || lower.includes('not found') && lower.includes('http')) {
    return 'This content could not be found. The link may be broken or removed.';
  }
  if (lower.match(/\b5\d{2}\b/) && (lower.includes('http') || lower.includes('server'))) {
    return 'The server is having issues. Please try again later.';
  }

  // ── Geo / region blocking ────────────────────────────────────────────────────
  if (
    lower.includes('geo') ||
    lower.includes('region') ||
    lower.includes('country') ||
    lower.includes('not available in your') ||
    lower.includes('blocked in')
  ) {
    return 'This content may not be available in your region.';
  }

  // ── Anti-bot / DRM / Cloudflare ──────────────────────────────────────────────
  if (lower.includes('cloudflare') || lower.includes('anti-bot') || lower.includes('captcha')) {
    return 'This site is protected. Please open it in your browser first, then retry.';
  }
  if (lower.includes('drm') || lower.includes('widevine') || lower.includes('encrypted media')) {
    return 'This content is DRM-protected and cannot be downloaded.';
  }

  // ── Disk / storage ───────────────────────────────────────────────────────────
  if (
    lower.includes('enospc') ||
    lower.includes('no space left') ||
    lower.includes('disk full') ||
    lower.includes('not enough storage')
  ) {
    return 'Not enough storage space. Free up space and retry.';
  }
  if (lower.includes('eacces') || lower.includes('permission denied') || lower.includes('access is denied')) {
    return 'Permission denied. Check that StreamDock can write to the download folder.';
  }

  // ── Unsupported / parse failures ─────────────────────────────────────────────
  if (lower.includes('unsupported url') || lower.includes('ie_key')) {
    return 'This site is not yet supported. Try pasting a direct media URL instead.';
  }
  if (
    lower.includes('no video formats found') ||
    lower.includes('no formats available') ||
    lower.includes('unable to extract')
  ) {
    return 'No downloadable media found at this URL. The page may be private or removed.';
  }
  if (lower.includes('invalid url') || lower.includes('url could not') || lower.includes('malformed')) {
    return 'This URL could not be recognized. Try a different link.';
  }

  // ── ffmpeg errors ────────────────────────────────────────────────────────────
  if (lower.includes('ffmpeg') || lower.includes('mux') || lower.includes('muxing')) {
    return 'FFmpeg is required for this operation and could not be used.';
  }

  // ── File corruption ──────────────────────────────────────────────────────────
  if (lower.includes('corrupt') || lower.includes('invalid data')) {
    return 'The file was corrupted. Restarting download.';
  }

  // ── yt-dlp crash / generic failure ──────────────────────────────────────────
  if (lower.includes('exited with code') || lower.includes('non-zero exit') || lower.includes('signal')) {
    return 'Download failed. Retry or check the link.';
  }

  // ── Clean up yt-dlp output if no specific translation matched ─────────────
  // Strip paths and stack traces, keep only the "ERROR:" line content
  const lines = raw.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  const errorLine = lines.find((l) => l.startsWith('ERROR:'));
  if (errorLine) {
    const cleaned = errorLine
      .replace(/^ERROR:\s*(?:\[[^\]]+\]\s*)?/, '')
      .replace(/[A-Za-z]:\\[^\s"']+/g, '')
      .replace(/\/[^\s"']{5,}/g, '')
      .trim();
    if (cleaned && cleaned.length > 4 && cleaned.length < 200) return cleaned;
  }

  return fallback;
}

/** Check if a raw yt-dlp output line indicates a retryable rate-limit condition. */
export function isRateLimited(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('429') || lower.includes('too many requests') || lower.includes('rate limit');
}

/** Check if a raw yt-dlp output line indicates auth/login is required. */
export function isAuthRequired(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('403') ||
    lower.includes('login required') ||
    lower.includes('sign in') ||
    lower.includes('private video') ||
    lower.includes('members only')
  );
}

/** Check if a raw yt-dlp output line indicates a geo-block. */
export function isGeoBlocked(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('not available in your country') || lower.includes('geo') || lower.includes('region');
}

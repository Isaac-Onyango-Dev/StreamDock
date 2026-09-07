// Role: user-facing error translation — ALL internal errors must pass through here.
// Users must NEVER see: stack traces, file paths, raw yt-dlp stderr, or internal details.
import log from 'electron-log';

/** Redact file-system paths and anything that looks like a credential from raw text. */
export function sanitizeRaw(raw: string): string {
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

  // Status/geo classification looks at the line that actually failed, not the
  // whole blob. yt-dlp's stderr routinely carries WARNING lines above the real
  // ERROR (e.g. its own "your version is older than 90 days" notice), and a
  // first-match-wins cascade over the concatenated text would let any of them
  // decide the message.
  const fatalLine = pickFatalLine(raw);
  const subject = fatalLine ?? raw;

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
  const subjectLower = subject.toLowerCase();

  if (isRateLimited(subject)) {
    return 'Rate limited by the site. Waiting before retrying…';
  }
  if (isAuthRequired(subject)) {
    // A 403 alongside yt-dlp's own staleness warning is almost never a login
    // wall, it is the site rejecting an outdated engine. Say the useful thing.
    if (mentionsStaleEngine(raw)) {
      return 'The site rejected the download engine because it is out of date. Update the engine and retry.';
    }
    return 'This content requires a login. Please log in on the site first.';
  }
  if (subjectLower.includes('login required') || subjectLower.includes('private video')) {
    return 'This content requires a login.';
  }
  if (hasHttpStatus(subjectLower, 404) || (subjectLower.includes('not found') && subjectLower.includes('http'))) {
    return 'This content could not be found. The link may be broken or removed.';
  }
  if (subjectLower.match(/\b5\d{2}\b/) && (subjectLower.includes('http') || subjectLower.includes('server'))) {
    return 'The server is having issues. Please try again later.';
  }

  // ── Geo / region blocking ────────────────────────────────────────────────────
  if (isGeoBlocked(subject)) {
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
  // An out-of-date engine is checked late so a specific, actionable cause still
  // wins, but ahead of the generic failure so it is never reported as a mystery.
  if (mentionsStaleEngine(raw)) {
    return 'The download engine is out of date, which is likely why this failed. Update it and retry.';
  }

  if (lower.includes('exited with code') || lower.includes('non-zero exit') || lower.includes('signal')) {
    return 'Download failed. Retry or check the link.';
  }

  // ── Clean up yt-dlp output if no specific translation matched ─────────────
  // Strip paths and stack traces, keep only the "ERROR:" line content
  const errorLine = fatalLine;
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

/**
 * HTTP status matching is deliberately anchored.
 *
 * These used to be bare `text.includes('429')` / `includes('403')` substring
 * tests, which match far more than an HTTP status: YouTube's AV1 itag is
 * literally 403 ("requested format 403 not available"), and 429 shows up in
 * fragment indices, byte counts and video IDs. A single stray digit run
 * anywhere in a multi-line stderr blob was enough to relabel an unrelated
 * failure as "Rate limited" or "requires a login".
 */
function hasHttpStatus(text: string, code: number): boolean {
  const lower = text.toLowerCase();
  // Only count a status that is introduced as one ("HTTP Error 403",
  // "status: 403", "code 403") or immediately followed by its reason phrase
  // ("403 Forbidden"). A bare digit run on its own is not evidence of anything.
  const introduced = /(?:http\s*(?:error|status)?\s*|status\s*[:=]?\s*|code\s*[:=]?\s*)(\d{3})\b/g;
  for (const match of lower.matchAll(introduced)) {
    if (Number(match[1]) === code) return true;
  }
  const withReason = /\b(\d{3})\s*:?\s*(?:forbidden|not found|too many requests|unauthorized)\b/g;
  for (const match of lower.matchAll(withReason)) {
    if (Number(match[1]) === code) return true;
  }
  return false;
}

/** Check if a raw yt-dlp output line indicates a retryable rate-limit condition. */
export function isRateLimited(text: string): boolean {
  const lower = text.toLowerCase();
  return hasHttpStatus(lower, 429)
    || lower.includes('too many requests')
    || /rate[- ]limit/.test(lower);
}

/** Check if a raw yt-dlp output line indicates auth/login is required. */
export function isAuthRequired(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    hasHttpStatus(lower, 403) ||
    hasHttpStatus(lower, 401) ||
    lower.includes('login required') ||
    lower.includes('sign in to') ||
    // Vimeo's current wording; several extractors phrase it this way rather
    // than returning a 401/403 we could match on.
    lower.includes('only works when logged-in') ||
    lower.includes('account credentials') ||
    lower.includes('private video') ||
    lower.includes('members only') ||
    lower.includes('members-only')
  );
}

/**
 * Check if a raw yt-dlp output line indicates a geo-block.
 *
 * Previously matched a bare 'geo' or 'region' substring, which fires on
 * ordinary text ("region", "geoip", CDN hostnames) and stole the
 * classification from the real error.
 */
export function isGeoBlocked(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    // yt-dlp's own wording is "The uploader has not made this video available
    // in your country", so the negation can sit several words from "available".
    /\bnot\b[^.]{0,40}\bavailable in your (?:country|region|location)\b/.test(lower) ||
    lower.includes('not available in your country') ||
    lower.includes('not available in your region') ||
    lower.includes('geo-restricted') ||
    lower.includes('geo restricted') ||
    lower.includes('geo-blocked') ||
    lower.includes('blocked in your country') ||
    lower.includes('this video is unavailable in your')
  );
}

/**
 * Detect yt-dlp telling us it is itself out of date.
 *
 * yt-dlp prints this to stderr as a WARNING, above the real ERROR line. A
 * stale engine is the single most common cause of "worked last month, fails
 * now" download failures, so it is worth calling out by name instead of
 * letting the downstream 403/429 get reported as a login wall or a rate limit.
 */
export function mentionsStaleEngine(text: string): boolean {
  const lower = text.toLowerCase();
  return /your yt-dlp version .* is older than/.test(lower)
    || lower.includes('it is strongly recommended to always use the latest version');
}

/**
 * Pick the line that actually caused the failure out of a multi-line stderr blob.
 *
 * Classifying the whole blob lets an incidental WARNING (or any line that
 * merely happens to contain a matching token) win over the real ERROR, because
 * the rule cascade returns on first match regardless of which line matched.
 * yt-dlp reports the fatal condition on its last `ERROR:` line.
 */
export function pickFatalLine(raw: string): string | null {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const errors = lines.filter((l) => /^error:/i.test(l));
  if (errors.length > 0) return errors[errors.length - 1];
  return null;
}

/**
 * Full technical detail for the UI's "show details" affordance.
 *
 * Redacted (paths/cookies/tokens stripped) but otherwise verbatim, so a user
 * can see the real HTTP status and engine stderr instead of only a friendly
 * summary. Returns the tail, which is where yt-dlp puts the failure.
 */
export function toErrorDetail(error: unknown, maxLength = 2000): string | null {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  if (!raw.trim()) return null;
  const cleaned = sanitizeRaw(raw)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > maxLength ? `…${cleaned.slice(-maxLength)}` : cleaned;
}

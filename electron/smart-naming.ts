// Role: pure-function output template builder for yt-dlp -o arguments.

export interface NamingRequest {
  mode: 'video' | 'stream';
  isPlaylist?: boolean;
  playlistItems?: string;
  folderHint?: string;
  /** Per-item title hint supplied by the UI (e.g. "One Piece - Episode 1 - Romance Dawn").
   *  Takes precedence over forcedTitle when present. */
  titleHint?: string;
  forcedTitle?: string;
}

/**
 * Sanitizes a user-supplied string for use as a filesystem folder or file name.
 *
 * Applied rules (in order):
 * 1. Replace every `\ / : * ? " < > |` character with `_`
 * 2. Strip leading and trailing whitespace
 * 3. Truncate to 150 UTF-8 bytes
 * 4. Return `'Download'` if the result is empty after sanitization
 */
export function sanitizeName(value: string): string {
  let s = value.replace(/[\\/:*?"<>|]/g, '_').trim();

  // Truncate to 150 UTF-8 bytes, respecting multi-byte characters
  let bytes = 0;
  let end = 0;
  for (const char of s) {
    const charBytes = Buffer.byteLength(char, 'utf-8');
    if (bytes + charBytes > 150) break;
    bytes += charBytes;
    end += char.length;
  }
  s = s.slice(0, end);

  return s || 'Download';
}

/**
 * Builds a yt-dlp `-o` output template string for the given naming request.
 *
 * Decision tree:
 *   Branch 1 — Stream: timestamp-based name, no subfolder
 *   Branch 2 — Playlist: named folder + zero-padded index + title
 *   Branch 3 — Video/audio with folderHint: series folder + optional Season subfolder + title
 *   Branch 4 — Single video fallback: plain title, no subfolder
 */
export function buildOutputTemplate(request: NamingRequest): string {
  const { mode, isPlaylist, playlistItems, folderHint, titleHint, forcedTitle } = request;
  // titleHint (per-item from UI) wins over forcedTitle (engine-derived fallback)
  const resolvedTitle = titleHint ?? forcedTitle;
  const titleStr = resolvedTitle ? sanitizeName(resolvedTitle) : '%(title).150B';

  // Branch 1: live stream
  if (mode === 'stream') {
    return 'StreamDock Stream %(upload_date>%Y-%m-%d)s %(epoch>%H-%M-%S)s.%(ext)s';
  }

  // Branch 2: playlist (isPlaylist true OR playlistItems is non-empty/non-whitespace)
  if (isPlaylist === true || (playlistItems && playlistItems.trim().length > 0)) {
    const folder = folderHint?.trim()
      ? sanitizeName(folderHint)
      : (resolvedTitle ? sanitizeName(resolvedTitle) : '%(playlist_title).150B');
    return `${folder}/%(playlist_index)03d-${titleStr}.%(ext)s`;
  }

  // Branch 3: video/audio with series context (non-playlist, folderHint present)
  if (folderHint?.trim()) {
    const folder = sanitizeName(folderHint);
    return `${folder}/%(season_number&Season %02d/|)s${titleStr}.%(ext)s`;
  }

  // Branch 4: single video, no context
  return `${titleStr}.%(ext)s`;
}

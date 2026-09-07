// Role: pure-function output template builder for yt-dlp -o arguments.
//
// Naming rules:
//   - Single video:  <title>.<ext>                       (never wrapped in a folder)
//   - Playlist:      <Playlist or show>/<title>.<ext>     (folder only once confirmed)
//   - Live stream:   timestamped name, no folder          (a live capture has no title yet)
//
// The previous version imposed a numbering scheme on top of this — "Episode (1)",
// "Episode (2)", nested under an optional "Season N" folder — and derived the
// counter from yt-dlp's playlist_index. It is gone, deliberately and entirely
// rather than left switched off: it renamed files away from the titles the
// extractor already knew, so a finished download was identifiable only by its
// position in a batch, and the season branch could only ever resolve for the
// handful of extractors that report season_number at all.

export interface NamingRequest {
  mode: 'video' | 'stream';
  /**
   * True only when the probe actually reported a playlist. Never inferred from
   * "the URL looks like it might have more than one thing behind it" — this is
   * what decides whether a folder gets created at all.
   */
  isPlaylist?: boolean;
  /** A yt-dlp --playlist-items selection, which implies a real playlist. */
  playlistItems?: string;
  /**
   * Folder name for a confirmed multi-item batch (playlist or series title).
   *
   * The caller must only set this once it knows more than one item is actually
   * being queued. It used to be sent for every episode-range download including
   * a single episode, which is how a lone video ended up inside a show folder.
   */
  folderHint?: string;
  /** Per-item title resolved by the UI from probe metadata. */
  titleHint?: string;
  /** Engine-derived fallback title (manifest downloads yt-dlp can't name itself). */
  forcedTitle?: string;
}

/**
 * Sanitizes a user-supplied string for use as a filesystem folder or file name.
 *
 * Applied rules (in order):
 * 1. Replace every RUN of `\ / : * ? " < > |` characters with a single `_`
 *    (e.g. "Ep<1>:Name" -> "Ep_1_Name", not "Ep_1__Name" — one underscore per
 *    illegal *run*, not one per illegal character)
 * 2. Strip leading and trailing whitespace
 * 3. Truncate to 150 UTF-8 bytes
 * 4. Return `'Download'` if the result is empty, or made up of underscores only,
 *    after sanitization (an all-underscore name carries no information — the
 *    input was entirely filesystem-illegal characters)
 */
export function sanitizeName(value: string): string {
  let s = value.replace(/[\\/:*?"<>|]+/g, '_').trim();

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

  return s && /[^_]/.test(s) ? s : 'Download';
}

/**
 * True when the caller has confirmed this download covers more than one item.
 *
 * Exported so the engine can answer "should a folder exist for this?" with the
 * same rule that builds the path, rather than a second copy that can drift.
 */
export function isConfirmedMultiItem(request: NamingRequest): boolean {
  return request.mode === 'video' && (
    request.isPlaylist === true ||
    Boolean(request.playlistItems?.trim()) ||
    Boolean(request.folderHint?.trim())
  );
}

/**
 * Builds a yt-dlp `-o` output template (relative to the download folder).
 *
 * The result is intentionally relative: the engine passes the destination as
 * `--paths home:`, so yt-dlp resolves the final location itself and can stage
 * everything in a separate temp directory until the file is actually finished.
 */
export function buildOutputTemplate(request: NamingRequest): string {
  const { mode, folderHint, titleHint, forcedTitle } = request;

  // A live capture has no title to name itself after at the moment it starts.
  if (mode === 'stream') {
    return 'StreamDock Stream %(upload_date>%Y-%m-%d)s %(epoch>%H-%M-%S)s.%(ext)s';
  }

  // titleHint (resolved by the UI from probe metadata) wins over forcedTitle
  // (the engine's fallback for manifest URLs yt-dlp cannot attach metadata to).
  // With neither, yt-dlp fills in the real title it extracted.
  const resolved = titleHint ?? forcedTitle;
  const fileName = `${resolved ? sanitizeName(resolved) : '%(title).150B'}.%(ext)s`;

  if (!isConfirmedMultiItem(request)) return fileName;

  const folder = folderHint?.trim()
    ? sanitizeName(folderHint)
    : '%(playlist_title).150B';
  return `${folder}/${fileName}`;
}

// Role: pure-function output template builder for yt-dlp -o arguments.
//
// Naming spec (StreamDock PRD):
//   - Single movie/video:            file_name.format                       (no folder)
//   - Multi-episode, no seasons:     <Show>/Episode (1).format, Episode (2).format, ...
//   - Multi-episode, with seasons:   <Show>/Season 1/Episode (1).format, ...

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
 * Builds a yt-dlp `-o` output template string for the given naming request.
 *
 * Decision tree:
 *   Branch 1 — Stream: timestamp-based name, no subfolder
 *   Branch 2 — Multi-item (playlist OR episode-range, i.e. isPlaylist/playlistItems/
 *              folderHint): "<Show>/[Season N/]Episode (playlist_index).ext" — season
 *              nesting is entirely conditional on the extractor actually reporting
 *              season_number, so a plain playlist with no season metadata correctly
 *              lands one level shallower ("no seasons" case in the spec).
 *              playlist_index (not episode_number) is deliberately used as the
 *              episode counter: it's guaranteed present and strictly unique/sequential
 *              per download batch, which is exactly what the spec's own examples show
 *              (Episode (1), Episode (2), ...) and sidesteps duplicate-episode-number
 *              metadata bugs some extractors have.
 *   Branch 3 — Single video/audio, no series context: plain title, no subfolder.
 */
export function buildOutputTemplate(request: NamingRequest): string {
  const { mode, isPlaylist, playlistItems, folderHint, titleHint, forcedTitle } = request;
  // titleHint (per-item from UI) wins over forcedTitle (engine-derived fallback)
  const resolvedTitle = titleHint ?? forcedTitle;
  const titleStr = resolvedTitle ? sanitizeName(resolvedTitle) : '%(title).150B';

  // Branch 1: live stream — always flat, never wrapped in a folder.
  if (mode === 'stream') {
    return 'StreamDock Stream %(upload_date>%Y-%m-%d)s %(epoch>%H-%M-%S)s.%(ext)s';
  }

  const isMultiItem = isPlaylist === true || Boolean(playlistItems?.trim()) || Boolean(folderHint?.trim());

  // Branch 2: multi-episode content (playlist or episode-range).
  if (isMultiItem) {
    const folder = folderHint?.trim()
      ? sanitizeName(folderHint)
      : (resolvedTitle ? sanitizeName(resolvedTitle) : '%(playlist_title).150B');

    // resolvedTitle means the caller already resolved a concrete per-item title
    // (UI titleHint, or the engine's manifest-retry forcedTitle for a raw CDN/
    // manifest URL yt-dlp can't attach metadata to) — use it directly instead of
    // the generic "Episode (N)" counter, and skip season nesting since a raw
    // manifest URL carries no season metadata for yt-dlp to resolve.
    if (resolvedTitle) {
      return `${folder}/${titleStr}.%(ext)s`;
    }

    // Season folder only appears when season_number actually resolves; not
    // zero-padded, per spec's own example ("Season 1", not "Season 01").
    const seasonPrefix = '%(season_number&Season %d/|)s';
    return `${folder}/${seasonPrefix}Episode (%(playlist_index)d).%(ext)s`;
  }

  // Branch 3: single video, no series context — flat file, no folder wrapping.
  return `${titleStr}.%(ext)s`;
}

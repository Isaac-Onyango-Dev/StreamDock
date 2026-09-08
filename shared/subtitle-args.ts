// Role: the single decision about what happens to subtitles on a download.
//
// This exists because two places used to decide. `applyLanguageAndSubtitleArgs`
// honoured the per-download picker, and then `applyYtDlpOptions` ran *after* it
// and appended `--embed-subs` whenever the global `embedSubs` setting was true —
// a setting whose persisted default was `true`. So choosing "None" still embedded
// a subtitle track, and choosing "Sidecar" produced an embedded track *and* a
// loose file. The settings pass ran last, so it always won.
//
// Verified against the engine rather than assumed: `--embed-subs` on its own is
// enough to make yt-dlp fetch subtitles.
//
//   $ yt-dlp --skip-download --print "%(requested_subtitles)s" URL
//   NA
//   $ yt-dlp --skip-download --embed-subs --print "%(requested_subtitles)s" URL
//   {'en': {'ext': 'vtt', 'name': 'English', ...}}
//
// The fix is structural, not a deleted line: one pure function owns the whole
// decision and returns the complete flag set, so nothing downstream is in a
// position to contradict it.
//
// The three behaviours are deliberately distinct and must not be conflated:
//   sidecar — a separate file beside the video       (non-destructive)
//   embed   — a track inside the container            (non-destructive)
//   burned  — pixels painted into the video           (NOT IMPLEMENTED, destructive)
// Burned-in subtitles are absent on purpose. They are irreversible, so they must
// never be reachable by default and should only ever be an explicit request.

export type SubtitleMode = 'none' | 'sidecar' | 'embed' | 'both';

export type SubtitleConvertFormat = 'original' | 'srt' | 'vtt';

export type DownloadPackagingMode =
  | 'video-only'
  | 'video-audio'
  | 'video-subs'
  | 'video-audio-subs'
  | 'video-multi-subs'
  | 'subs-only';

export interface SubtitleRequest {
  /** The per-download choice. Authoritative — nothing overrides it. */
  subtitleMode?: SubtitleMode;
  /** "Subtitles only, no video" — a distinct user action, not a mode. */
  subsOnly?: boolean;
  downloadPackaging?: DownloadPackagingMode;
  selectedSubtitleLanguages?: string[];
  subtitleConvertFormat?: SubtitleConvertFormat;
}

/** The default when a request carries no explicit choice. */
export const DEFAULT_SUBTITLE_MODE: SubtitleMode = 'embed';

/**
 * What should actually happen to subtitles for this request.
 *
 * `subsOnly` (and its packaging equivalent) is the one thing that outranks the
 * picker, because "download just the subtitles" is a different action rather
 * than a different preference — there is no video to embed into.
 *
 * Otherwise the picker wins outright. In particular an explicit 'none' is
 * honoured even when subtitle tracks are selected in the language modal: the
 * previous logic treated any selected language as a request for subtitles, so
 * a leftover selection silently re-enabled them.
 */
export function resolveSubtitleMode(request: SubtitleRequest): SubtitleMode {
  if (request.subsOnly || request.downloadPackaging === 'subs-only') return 'sidecar';
  return request.subtitleMode ?? DEFAULT_SUBTITLE_MODE;
}

/**
 * The complete set of subtitle-related yt-dlp arguments for this request.
 *
 * Returns everything or nothing: callers push the result and add no subtitle
 * flags of their own.
 */
export function buildSubtitleArgs(request: SubtitleRequest): string[] {
  const mode = resolveSubtitleMode(request);
  if (mode === 'none') return [];

  const args: string[] = [];

  // Plain 'en', never 'en.*'. The wildcard also matches YouTube's machine
  // translations (en-en, en-de, …), turning one subtitle fetch into a burst of
  // them — enough to earn a 429 that aborts the whole video download and gets
  // reported to the user as a rate limit on the video itself.
  const langs = request.selectedSubtitleLanguages?.length
    ? request.selectedSubtitleLanguages.join(',')
    : 'en';
  args.push('--sub-langs', langs);

  // `--write-subs` means "keep the subtitle file". `--embed-subs` means "mux it
  // in", and on its own yt-dlp deletes the file again afterwards. Asking for
  // both is therefore the correct — and only — way to get 'both', and asking
  // for both by accident is what used to leave stray .vtt files behind.
  if (mode === 'sidecar' || mode === 'both') {
    args.push('--write-subs', '--write-auto-subs');
  }
  if (mode === 'embed' || mode === 'both') {
    args.push('--embed-subs');
  }

  if (request.subtitleConvertFormat === 'srt') args.push('--convert-subs', 'srt');
  if (request.subtitleConvertFormat === 'vtt') args.push('--convert-subs', 'vtt');

  return args;
}

/**
 * Migrates the old boolean setting to a mode.
 *
 * `ytdlpOptions.embedSubs` was a global on/off that silently overrode the
 * per-download picker. It becomes the *default value* of that picker instead,
 * so an existing install keeps the behaviour it had unless the user changes it.
 * Applied on read; never written back.
 */
export function subtitleModeFromSettings(options: {
  subtitleMode?: SubtitleMode;
  embedSubs?: boolean;
} | undefined): SubtitleMode {
  if (options?.subtitleMode) return options.subtitleMode;
  if (options?.embedSubs === false) return 'none';
  return DEFAULT_SUBTITLE_MODE;
}

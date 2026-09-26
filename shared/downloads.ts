// Role: the download types both processes speak — the one definition.
//
// The engine and the renderer each kept their own copy, and the preload a
// third: its request type had already lost `displayTitle`, which the renderer
// sends on every download. Types that cross the IPC boundary live here.
import type { DownloadPackagingMode, SubtitleMode } from './subtitle-args';

export type CaptureMode = 'video' | 'stream';

export interface DownloadRequest {
  url: string;
  mode: CaptureMode;
  outputDir: string;
  quality?: string;
  playlistItems?: string;
  audioPreference?: 'auto' | 'dub' | 'sub';
  subtitleMode?: SubtitleMode;
  isPlaylist?: boolean;
  /** A suggested folder name from the UI (e.g. series or playlist title) */
  folderHint?: string;
  /** Per-item title hint from the UI (e.g. "One Piece - Episode 1 - Romance Dawn").
   *  Used as the output *filename* for manifest-based VOD downloads where yt-dlp
   *  cannot derive a meaningful title from the CDN stream URL. Only ever set for
   *  a spawn covering a single item — one hint across a playlist would give
   *  every file in it the same name. */
  titleHint?: string;
  /** Label for the queue row only; never used to build a filename.
   *  Kept separate from titleHint precisely so a playlist can show its real
   *  name in the UI without that name being forced onto every file it
   *  contains — the queue row and the output template are different questions. */
  displayTitle?: string;
  /** Whether to use browser cookies */
  useCookies?: boolean;
  /** Browser to impersonate for TLS fingerprinting */
  impersonate?: string;
  /** Additional plugin directories */
  pluginDirs?: string[];
  /** Priority in queue (lower = higher priority). Default: 100 */
  priority?: number;
  /** Optional scheduled start time (ISO string) */
  scheduledAt?: string;
  /** Thumbnail URL for display */
  thumbnail?: string;
  /** Explicit audio language code from media track probe (e.g. en, ja) */
  selectedAudioLanguage?: string;
  /** Explicit yt-dlp audio format ID selected by the user. Preferred over language filters. */
  selectedAudioFormatId?: string;
  /** Manifest URL that produced the selected audio track, used to reject mixed-CDN combinations. */
  selectedAudioManifestUrl?: string;
  /** Subtitle language codes to download */
  selectedSubtitleLanguages?: string[];
  /** Explicit yt-dlp subtitle format IDs, when exposed by the extractor. */
  selectedSubtitleFormatIds?: string[];
  /** Manifest URLs that produced selected subtitle tracks, used to reject mixed-CDN combinations. */
  selectedSubtitleManifestUrls?: string[];
  /** Convert subtitles to this format (original keeps source ext) */
  subtitleConvertFormat?: 'original' | 'srt' | 'vtt';
  /** Download subtitles without video */
  subsOnly?: boolean;
  /** User-selected packaging mode from language UI */
  downloadPackaging?: DownloadPackagingMode;
  /** User-selected manifest URL from stream options probe (for language-specific streams) */
  manifestUrl?: string;
  /** Referer URL for the selected manifest (for sites that require it) */
  manifestReferer?: string;
  /**
   * Language to select on each episode page, for hosts that serve sub and dub
   * as separate streams.
   *
   * A batch cannot reuse one probed manifest — the CDN token expires in about
   * 90 seconds, long before a queue reaches its later episodes — so each
   * episode is probed at its own download time and needs to be told which
   * language to pick. Without this every episode of a "Dub" range came down as
   * the site default, which is Sub.
   */
  translation?: string;
}

/**
 * Where a download is in its lifecycle. Only transition() assigns it.
 *
 * `resolving` is the manifest-extraction phase. It used to be shown by writing
 * "Extracting stream manifest…" into the *title*, which then had to be
 * recognised and undone by string comparison before the title could be used as
 * a filename — and one of those status strings was missing from the list.
 */
export type DownloadStatus =
  | 'scheduled'
  | 'queued'
  | 'resolving'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface DownloadRecord {
  id: string;
  /**
   * Bumped on every event the engine sends for this download. The renderer
   * applies an event only if it is newer than what it holds, so a snapshot or
   * an event arriving late on another channel cannot roll a row back.
   */
  revision: number;
  url: string;
  mode: CaptureMode;
  title: string;
  status: DownloadStatus;
  progress: number;
  speed: string;
  eta: string;
  outputPath?: string;
  error?: string;
  createdAt: string;
  priority: number;
  thumbnail?: string;
  /** Bytes downloaded (parsed from yt-dlp output) */
  bytesDownloaded: number;
  /** Total bytes (parsed from yt-dlp output) */
  bytesTotal: number;
  /** Detected format */
  detectedFormat?: string;
  /** Stall message for UI */
  stallMessage?: string;
  /** Why a queued or scheduled download has not started. */
  waitReason?: string;
  /** The language the user asked this download for (sub/dub), if any. */
  requestedTranslation?: string;
  /** The language the source was proven to serve — set only when proven. */
  resolvedTranslation?: string;
  /**
   * The file was already on disk, so yt-dlp skipped it (`--no-overwrites`).
   *
   * Without this the row reported a plain "completed" for a run that fetched
   * nothing — a 200MB episode "downloading" in six seconds. Stale files from an
   * earlier bad run then silently masked whether a fix worked at all.
   */
  alreadyExisted?: boolean;
  /**
   * Redacted engine output for the failure, shown behind a "details" toggle.
   *
   * `error` is a friendly one-liner, which on its own made this whole class of
   * bug undiagnosable from the UI: a stale-engine 403 and a genuine login wall
   * produced the same sentence. This carries the real HTTP status and stderr.
   */
  errorDetail?: string;
}

/** What "Clear" removes from the list. */
export type ClearRecordScope = 'all' | 'completed' | 'failed' | 'cancelled';

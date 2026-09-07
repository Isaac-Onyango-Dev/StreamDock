// Role: shared renderer-side TypeScript types for StreamDock.

export type CaptureMode = 'video' | 'stream';

export interface UrlAnalysis {
  url: string;
  host: string;
  valid: boolean;
  suggestedMode: CaptureMode;
  reason: string;
}

export interface PlaylistProbeItem {
  id?: string;
  title: string;
  url?: string;
  duration?: number;
  thumbnail?: string;
}

export interface QualityOption {
  height: number;
  label: string;
}

export interface PlaylistProbe {
  url: string;
  host: string;
  title: string;
  support: 'direct' | 'playlist' | 'episode-range' | 'manifest-probe' | 'unknown';
  itemCount: number;
  preview: PlaylistProbeItem[];
  qualityOptions?: QualityOption[];
  thumbnail?: string;
  extractor?: string;
  isLive: boolean;
  notes: string[];
}

export interface DownloadRecord {
  id: string;
  url: string;
  mode: CaptureMode;
  title: string;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'retrying' | 'scheduled';
  progress: number;
  speed: string;
  eta: string;
  outputPath?: string;
  error?: string;
  createdAt: string;
  priority: number;
  /** Thumbnail URL (from yt-dlp metadata or probe) */
  thumbnail?: string;
  /** Bytes downloaded (parsed from yt-dlp progress output) */
  bytesDownloaded: number;
  /** Total bytes (parsed from yt-dlp progress output, 0 = unknown) */
  bytesTotal: number;
  /** Detected media format (hls/dash/mp4/etc.) */
  detectedFormat?: string;
  /** Stall message shown in UI when connection drops */
  stallMessage?: string;
  /** Redacted engine output for a failure, shown behind a "details" toggle. */
  errorDetail?: string;
}

export interface EngineStatus {
  name: 'yt-dlp' | 'ffmpeg';
  path: string | null;
  available: boolean;
}

export type SubtitleFormat = 'vtt' | 'srt' | 'ass' | 'ssa' | 'ttml' | 'unknown';

export type DownloadPackagingMode =
  | 'video-only'
  | 'video-audio'
  | 'video-subs'
  | 'video-audio-subs'
  | 'video-multi-subs'
  | 'subs-only';

export interface AudioTrack {
  id: string;
  language: string;
  label: string;
  formatId?: string;
  name?: string;
  isDefault: boolean;
  isOriginal: boolean;
  isDub: boolean;
  codec?: string;
  bitrate?: number;
  groupId?: string;
  uri?: string;
  manifestUrl?: string;
}

export interface SubtitleTrack {
  id: string;
  language: string;
  label: string;
  formatId?: string;
  format: SubtitleFormat;
  isDefault: boolean;
  groupId?: string;
  uri?: string;
  manifestUrl?: string;
}

export interface MediaTrackProbe {
  url: string;
  manifestUrl?: string;
  manifestType?: 'm3u8' | 'mpd';
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
  qualityOptions: QualityOption[];
  defaultAudioLanguage?: string;
  originalAudioLanguage?: string;
  notes: string[];
  source: 'manifest' | 'ytdlp' | 'combined';
}

export interface StreamOption {
  label: string;
  manifestUrl: string;
  manifestType: 'm3u8' | 'mpd' | 'mp4';
  referer?: string;
  isDefault: boolean;
  /** DUB/SUB/HUB classification, always populated ('Unknown' when undetectable). */
  language: string;
}

export interface StreamOptionsProbeResult {
  success: boolean;
  url: string;
  options: StreamOption[];
  defaultOption?: StreamOption;
  error?: string;
}

export interface StartRequest {
  url: string;
  outputDir: string;
  quality?: string;
  playlistItems?: string;
  audioPreference?: 'auto' | 'dub' | 'sub';
  subtitleMode?: 'none' | 'embed' | 'sidecar';
  isPlaylist?: boolean;
  folderHint?: string;
  /** Per-item title for episode/series downloads (e.g. "One Piece - Episode 1 - Romance Dawn"). */
  titleHint?: string;
  /** Queue-row label only; never used to build a filename. */
  displayTitle?: string;
  impersonate?: string;
  pluginDirs?: string[];
  priority?: number;
  scheduledAt?: string;
  thumbnail?: string;
  selectedAudioLanguage?: string;
  selectedAudioFormatId?: string;
  selectedAudioManifestUrl?: string;
  selectedSubtitleLanguages?: string[];
  selectedSubtitleFormatIds?: string[];
  selectedSubtitleManifestUrls?: string[];
  subtitleConvertFormat?: 'original' | 'srt' | 'vtt';
  subsOnly?: boolean;
  downloadPackaging?: DownloadPackagingMode;
}

/**
 * 'gradient' is the install site's own gradient and the app default;
 * 'theme' selects one of the ambient themes named by `backgroundTheme`.
 */
export type BackgroundMode = 'solid' | 'bing' | 'picsum' | 'gradient' | 'theme';

export interface Settings {
  downloadDir: string;
  useCookies?: boolean;
  maxConcurrent?: number;
  scheduledStartTime?: string | null;
  hasOnboarded?: boolean;
  densityMode?: 'comfortable' | 'compact';
  backgroundMode?: BackgroundMode;
  backgroundImageUrl?: string;
  solidColorBg?: string;
  /** Ambient theme id, used when backgroundMode is 'theme'. */
  backgroundTheme?: string;
  bingRefreshInterval?: number;
  clipboardWatcher?: boolean;
  ytdlpOptions?: {
    embedSubs?: boolean;
    embedMetadata?: boolean;
    sponsorBlock?: boolean;
    customArgs?: string;
  };
}

export type QueueStats = {
  active: number;
  queued: number;
  maxConcurrent: number;
};

export type Tab = 'capture' | 'transfers' | 'settings';

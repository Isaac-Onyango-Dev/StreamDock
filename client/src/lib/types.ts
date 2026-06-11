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

export interface PlaylistProbe {
  url: string;
  host: string;
  title: string;
  support: 'direct' | 'playlist' | 'episode-range' | 'manifest-probe' | 'unknown';
  itemCount: number;
  preview: PlaylistProbeItem[];
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
  name?: string;
  isDefault: boolean;
  isOriginal: boolean;
  isDub: boolean;
  codec?: string;
  bitrate?: number;
  groupId?: string;
  uri?: string;
}

export interface SubtitleTrack {
  id: string;
  language: string;
  label: string;
  format: SubtitleFormat;
  isDefault: boolean;
  groupId?: string;
  uri?: string;
}

export interface MediaTrackProbe {
  url: string;
  manifestUrl?: string;
  manifestType?: 'm3u8' | 'mpd';
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
  defaultAudioLanguage?: string;
  originalAudioLanguage?: string;
  notes: string[];
  source: 'manifest' | 'ytdlp' | 'combined';
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
  impersonate?: string;
  pluginDirs?: string[];
  priority?: number;
  scheduledAt?: string;
  thumbnail?: string;
  selectedAudioLanguage?: string;
  selectedSubtitleLanguages?: string[];
  subtitleConvertFormat?: 'original' | 'srt' | 'vtt';
  subsOnly?: boolean;
  downloadPackaging?: DownloadPackagingMode;
}

export interface Settings {
  downloadDir: string;
  useCookies?: boolean;
  maxConcurrent?: number;
  scheduledStartTime?: string | null;
  hasOnboarded?: boolean;
  densityMode?: 'comfortable' | 'compact';
}

export type QueueStats = {
  active: number;
  queued: number;
  maxConcurrent: number;
};

export type Tab = 'capture' | 'transfers' | 'settings';

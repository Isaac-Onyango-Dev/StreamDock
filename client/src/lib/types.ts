import type { LanguageConfidence, TranslationType } from '../../../shared/language';

// Role: shared renderer-side TypeScript types for StreamDock.

// Types that cross the IPC boundary are defined once, in shared/.
import type { CaptureMode } from '../../../shared/downloads';
export type { CaptureMode, DownloadRecord, DownloadRequest, DownloadStatus } from '../../../shared/downloads';
export type { DownloadPackagingMode } from '../../../shared/subtitle-args';

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

export interface EngineStatus {
  name: 'yt-dlp' | 'ffmpeg';
  path: string | null;
  available: boolean;
}

export type SubtitleFormat = 'vtt' | 'srt' | 'ass' | 'ssa' | 'ttml' | 'unknown';

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
  /** Display language, always populated ('Unknown' when undetectable). */
  language: string;
  /** Dub / sub / raw, carried separately from the spoken language. */
  translation: TranslationType;
  /** Whether `language` was declared by the source or guessed from a URL. */
  languageConfidence: LanguageConfidence;
}

export interface StreamOptionsProbeResult {
  success: boolean;
  url: string;
  options: StreamOption[];
  defaultOption?: StreamOption;
  error?: string;
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
    /** Default for the per-download Subtitles picker (replaces embedSubs). */
    subtitleMode?: 'none' | 'sidecar' | 'embed' | 'both';
    /** @deprecated Migrated to subtitleMode on read. */
    embedSubs?: boolean;
    embedMetadata?: boolean;
    sponsorBlock?: boolean;
    customArgs?: string;
  };
}

export type Tab = 'capture' | 'transfers' | 'settings';

// Role: renderer declaration for the secure Electron preload API.
import type {
  CaptureMode,
  DownloadRecord,
  DownloadPackagingMode,
  EngineStatus,
  MediaTrackProbe,
  Settings,
  UrlAnalysis,
} from '../lib/types';

export {};

declare global {
  interface Window {
    streamDock?: {
      getVersion: () => Promise<string>;
      getSettings: () => Promise<Settings>;
      updateSettings: (updates: Partial<Settings>) => Promise<Settings>;
      selectDownloadFolder: () => Promise<string | null>;
      readClipboard: () => Promise<string>;
      analyzeUrl: (
        url: string,
      ) => Promise<{ success: true; data: UrlAnalysis } | { success: false; error: string }>;
      inspectUrl: (
        url: string,
      ) => Promise<{ success: true; data: import('../lib/types').PlaylistProbe } | { success: false; error: string }>;
      probeMediaTracks: (payload: {
        pageUrl: string;
        manifestUrl?: string;
        referer?: string;
      }) => Promise<{ success: true; data: MediaTrackProbe } | { success: false; error: string }>;
      getEngineStatus: () => Promise<EngineStatus[]>;
      startDownload: (
        mode: CaptureMode,
        request: {
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
          scheduledAt?: string;
          priority?: number;
          selectedAudioLanguage?: string;
          selectedSubtitleLanguages?: string[];
          subtitleConvertFormat?: 'original' | 'srt' | 'vtt';
          subsOnly?: boolean;
          downloadPackaging?: DownloadPackagingMode;
        },
      ) => Promise<DownloadRecord>;
      cancelDownload: (id: string) => Promise<boolean>;
      pauseDownload: (id: string) => Promise<boolean>;
      resumeDownload: (id: string) => Promise<boolean>;
      retryDownload: (id: string) => Promise<boolean>;
      stopAll: (mode?: 'pause' | 'cancel') => Promise<boolean>;
      resumeAll: () => Promise<boolean>;
      reorderDownload: (id: string, newPosition: number) => Promise<boolean>;
      listDownloads: () => Promise<DownloadRecord[]>;
      clearEngineRecords: (scope?: 'all' | 'completed' | 'failed' | 'cancelled') => Promise<boolean>;
      updateEngine: () => Promise<{ success: boolean; message?: string; error?: string }>;
      openFile: (filePath: string) => Promise<void>;
      showInFolder: (filePath: string) => Promise<void>;
      // Window controls
      minimizeWindow: () => Promise<void>;
      maximizeRestoreWindow: () => Promise<void>;
      closeWindow: () => Promise<void>;
      getPlatform: () => string;
      // Window focus/blur events
      onWindowFocused: (callback: () => void) => () => void;
      onWindowBlurred: (callback: () => void) => () => void;
      // Notifications & badge
      notifyDownloadComplete: (title: string) => Promise<void>;
      updateActiveCount: (count: number) => Promise<void>;
      // Onboarding
      markOnboarded: () => Promise<void>;
      // Download events
      onDownloadProgress: (callback: (record: DownloadRecord) => void) => () => void;
      onDownloadComplete: (callback: (record: DownloadRecord) => void) => () => void;
      onDownloadError: (callback: (record: DownloadRecord) => void) => () => void;
      onEngineVersionWarning: (callback: (warning: string) => void) => () => void;
      onMenuFocusTab: (callback: (tab: string) => void) => () => void;
      onMenuOpenDownloadFolder: (callback: () => void) => () => void;
      onMenuPasteClipboard: (callback: () => void) => () => void;
    };
  }
}

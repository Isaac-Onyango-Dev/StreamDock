// Role: renderer declaration for the secure Electron preload API.
import type {
  CaptureMode,
  DownloadRecord,
  DownloadRequest,
  EngineStatus,
  MediaTrackProbe,
  Settings,
  StreamOptionsProbeResult,
  UrlAnalysis,
} from '../lib/types';
import type { UpdateState } from '../../../shared/update-state';

export {};

declare global {
  interface Window {
    streamDock?: {
      // Application update. The renderer owns the visible flow; these drive it.
      getUpdateState: () => Promise<UpdateState>;
      checkForAppUpdate: () => Promise<UpdateState>;
      downloadAppUpdate: () => Promise<UpdateState>;
      installAppUpdate: () => Promise<UpdateState>;
      dismissAppUpdate: () => Promise<UpdateState>;
      onAppUpdateState: (callback: (next: UpdateState) => void) => () => void;
      getSettings: () => Promise<Settings>;
      updateSettings: (updates: Partial<Settings>) => Promise<Settings>;
      pluginsList: () => Promise<Array<{ name: string; path: string }>>;
      /** Best-effort advisory only. Never throws; resolves 'unknown' on failure. */
      checkSourceStatus: (host: string) => Promise<'active' | 'retired' | 'unknown'>;
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
      probeStreamOptions: (pageUrl: string) => Promise<StreamOptionsProbeResult>;
      getEngineStatus: () => Promise<EngineStatus[]>;
      startDownload: (
        mode: CaptureMode,
        request: Omit<DownloadRequest, 'mode'>,
      ) => Promise<DownloadRecord>;
      cancelDownload: (id: string) => Promise<boolean>;
      pauseDownload: (id: string) => Promise<boolean>;
      resumeDownload: (id: string) => Promise<boolean>;
      retryDownload: (id: string) => Promise<boolean>;
      stopAll: (mode?: 'pause' | 'cancel') => Promise<boolean>;
      resumeAll: () => Promise<boolean>;
      listDownloads: () => Promise<DownloadRecord[]>;
      removeDownload: (id: string) => Promise<boolean>;
      clearEngineRecords: (scope?: 'all' | 'completed' | 'failed' | 'cancelled') => Promise<boolean>;
      updateEngine: () => Promise<{ success: boolean; message?: string; error?: string }>;
      getMenuLabels?: () => Promise<string[]>;
      popupMenu?: (label: string, x: number, y: number) => Promise<boolean>;
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
      // Onboarding
      // Download events
      onDownloadProgress: (callback: (record: DownloadRecord) => void) => () => void;
      onDownloadComplete: (callback: (record: DownloadRecord) => void) => () => void;
      onDownloadError: (callback: (record: DownloadRecord) => void) => () => void;
      onDownloadRemoved: (callback: (ids: string[]) => void) => () => void;
      onEngineVersionWarning: (callback: (warning: string) => void) => () => void;
      onMenuFocusTab: (callback: (tab: string) => void) => () => void;
      onMenuOpenDownloadFolder: (callback: () => void) => () => void;
      onMenuPasteClipboard: (callback: () => void) => () => void;
      // Clipboard watcher
      startClipboardWatcher: () => Promise<boolean>;
      stopClipboardWatcher: () => Promise<boolean>;
      onClipboardUrl: (callback: (data: { url: string; sourceText: string }) => void) => () => void;
      // Background
      rotateNow: () => Promise<string | null>;
      onWallpaperUpdated: (callback: (url: string) => void) => () => void;
    };
  }
}

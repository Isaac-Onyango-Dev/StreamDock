// Role: secure contextBridge API exposed to the StreamDock renderer.
import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from './ipc-channels';
import type { DownloadRecord } from './download-engine';
import type { CaptureMode, UrlAnalysis } from './url-router';

type Settings = {
  downloadDir: string;
  useCookies?: boolean;
  maxConcurrent?: number;
  scheduledStartTime?: string | null;
  hasOnboarded?: boolean;
  densityMode?: 'comfortable' | 'compact';
};

type StartRequest = {
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
  downloadPackaging?: 'video-only' | 'video-audio' | 'video-subs' | 'video-audio-subs' | 'video-multi-subs' | 'subs-only';
};

type Unsubscribe = () => void;
type MenuCallback = (tab: string) => void;
type ClearRecordScope = 'all' | 'completed' | 'failed' | 'cancelled';

const on = <T>(channel: string, callback: (payload: T) => void): Unsubscribe => {
  const handler = (_event: unknown, payload: T) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

const api = {
  // App
  getVersion: () => ipcRenderer.invoke(IPC.APP_GET_VERSION) as Promise<string>,
  onEngineVersionWarning: (callback: (warning: string) => void): Unsubscribe =>
    on<string>(IPC.APP_ENGINE_VERSION_WARNING, callback),
  markOnboarded: () => ipcRenderer.invoke(IPC.APP_MARK_ONBOARDED) as Promise<void>,

  // Window controls
  minimizeWindow: () => ipcRenderer.invoke(IPC.WINDOW_MINIMIZE),
  maximizeRestoreWindow: () => ipcRenderer.invoke(IPC.WINDOW_MAXIMIZE_RESTORE),
  closeWindow: () => ipcRenderer.invoke(IPC.WINDOW_CLOSE),
  getPlatform: () => process.platform,

  // Window focus/blur events
  onWindowFocused: (callback: () => void): Unsubscribe => on<void>(IPC.WINDOW_FOCUSED, callback),
  onWindowBlurred: (callback: () => void): Unsubscribe => on<void>(IPC.WINDOW_BLURRED, callback),

  // Notification & OS Badges
  notifyDownloadComplete: (title: string) =>
    ipcRenderer.invoke(IPC.NOTIFICATION_DOWNLOAD_COMPLETE, { title }) as Promise<void>,
  updateActiveCount: (count: number) => ipcRenderer.invoke(IPC.DOWNLOADS_ACTIVE_COUNT, count),

  // Settings
  getSettings: () => ipcRenderer.invoke(IPC.SETTINGS_GET) as Promise<Settings>,
  updateSettings: (updates: Partial<Settings>) =>
    ipcRenderer.invoke(IPC.SETTINGS_UPDATE, updates) as Promise<Settings>,

  // Dialog
  selectDownloadFolder: () =>
    ipcRenderer.invoke(IPC.DIALOG_SELECT_DOWNLOAD_FOLDER) as Promise<string | null>,

  // Clipboard
  readClipboard: () => ipcRenderer.invoke(IPC.CLIPBOARD_READ_TEXT) as Promise<string>,

  // URL analysis
  analyzeUrl: (url: string) =>
    ipcRenderer.invoke(IPC.URL_ANALYZE, url) as Promise<
      { success: true; data: UrlAnalysis } | { success: false; error: string }
    >,
  inspectUrl: (url: string) => ipcRenderer.invoke(IPC.URL_INSPECT, url),
  probeMediaTracks: (payload: { pageUrl: string; manifestUrl?: string; referer?: string }) =>
    ipcRenderer.invoke(IPC.MEDIA_PROBE_TRACKS, payload),

  // Engine status
  getEngineStatus: () => ipcRenderer.invoke(IPC.ENGINE_STATUS),

  // Download lifecycle
  startDownload: (mode: CaptureMode, request: StartRequest) =>
    ipcRenderer.invoke(
      mode === 'stream' ? IPC.DOWNLOAD_START_STREAM : IPC.DOWNLOAD_START_VIDEO,
      request,
    ) as Promise<DownloadRecord>,
  cancelDownload: (id: string) => ipcRenderer.invoke(IPC.DOWNLOAD_CANCEL, id) as Promise<boolean>,
  pauseDownload: (id: string) => ipcRenderer.invoke(IPC.DOWNLOAD_PAUSE, id) as Promise<boolean>,
  resumeDownload: (id: string) => ipcRenderer.invoke(IPC.DOWNLOAD_RESUME, id) as Promise<boolean>,
  retryDownload: (id: string) => ipcRenderer.invoke(IPC.DOWNLOAD_RETRY, id) as Promise<boolean>,
  stopAll: (mode?: 'pause' | 'cancel') =>
    ipcRenderer.invoke(IPC.DOWNLOAD_STOP_ALL, mode ?? 'pause') as Promise<boolean>,
  resumeAll: () => ipcRenderer.invoke(IPC.DOWNLOAD_RESUME_ALL) as Promise<boolean>,
  reorderDownload: (id: string, newPosition: number) =>
    ipcRenderer.invoke(IPC.DOWNLOAD_REORDER, id, newPosition) as Promise<boolean>,
  listDownloads: () => ipcRenderer.invoke(IPC.DOWNLOAD_LIST) as Promise<DownloadRecord[]>,

  // File operations
  openFile: (filePath: string) => ipcRenderer.invoke(IPC.DOWNLOAD_OPEN_FILE, filePath),
  showInFolder: (filePath: string) => ipcRenderer.invoke(IPC.DOWNLOAD_SHOW_IN_FOLDER, filePath),

  // Engine management
  clearEngineRecords: (scope: ClearRecordScope = 'all') =>
    ipcRenderer.invoke(IPC.ENGINE_CLEAR_RECORDS, scope) as Promise<boolean>,
  updateEngine: () =>
    ipcRenderer.invoke(IPC.ENGINE_UPDATE) as Promise<{ success: boolean; message?: string; error?: string }>,

  // Event subscriptions
  onDownloadProgress: (callback: (record: DownloadRecord) => void): Unsubscribe =>
    on<DownloadRecord>(IPC.EVENT_DOWNLOAD_PROGRESS, callback),
  onDownloadComplete: (callback: (record: DownloadRecord) => void): Unsubscribe =>
    on<DownloadRecord>(IPC.EVENT_DOWNLOAD_COMPLETE, callback),
  onDownloadError: (callback: (record: DownloadRecord) => void): Unsubscribe =>
    on<DownloadRecord>(IPC.EVENT_DOWNLOAD_ERROR, callback),

  // Menu events
  onMenuFocusTab: (callback: MenuCallback): Unsubscribe =>
    on<string>('menu:focus-tab', callback),
  onMenuOpenDownloadFolder: (callback: () => void): Unsubscribe =>
    on<void>('menu:open-download-folder', callback),
  onMenuPasteClipboard: (callback: () => void): Unsubscribe =>
    on<void>('menu:paste-clipboard', callback),
};

contextBridge.exposeInMainWorld('streamDock', api);

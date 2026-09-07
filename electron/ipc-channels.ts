// Role: documented IPC channel constants shared by main and preload.

export const IPC = {
  // App
  APP_GET_VERSION:              'app:get-version',
  APP_ENGINE_VERSION_WARNING:   'app:engine-version-warning',
  APP_MARK_ONBOARDED:           'app:mark-onboarded',

  // Window controls (renderer → main)
  WINDOW_MINIMIZE:          'window:minimize',
  WINDOW_MAXIMIZE_RESTORE:  'window:maximize-restore',
  WINDOW_CLOSE:             'window:close',

  // Window focus/blur events (main → renderer)
  WINDOW_FOCUSED:  'window:focused',
  WINDOW_BLURRED:  'window:blurred',
  WINDOW_PLATFORM: 'window:platform',

  // Dialog
  DIALOG_SELECT_DOWNLOAD_FOLDER: 'dialog:select-download-folder',
  DIALOG_ACTIVE_DOWNLOADS:       'dialog:active-downloads',

  // Clipboard
  CLIPBOARD_READ_TEXT: 'clipboard:read-text',

  // URL analysis
  URL_ANALYZE: 'url:analyze',
  URL_INSPECT: 'url:inspect',
  MEDIA_PROBE_TRACKS: 'media:probe-tracks',
  STREAM_OPTIONS_PROBE: 'stream:options-probe',

  // Download lifecycle
  DOWNLOAD_START_VIDEO:     'download:start-video',
  DOWNLOAD_START_STREAM:    'download:start-stream',
  DOWNLOAD_PAUSE:           'download:pause',
  DOWNLOAD_RESUME:          'download:resume',
  DOWNLOAD_RETRY:           'download:retry',
  DOWNLOAD_CANCEL:          'download:cancel',
  DOWNLOAD_STOP_ALL:        'download:stop-all',
  DOWNLOAD_RESUME_ALL:      'download:resume-all',
  DOWNLOAD_OPEN_FILE:       'download:open-file',
  DOWNLOAD_SHOW_IN_FOLDER:  'download:show-in-folder',
  DOWNLOAD_REORDER:         'download:reorder',
  DOWNLOAD_LIST:            'download:list',

  // Settings
  SETTINGS_GET:    'settings:get',
  SETTINGS_UPDATE: 'settings:update',
  PLUGINS_LIST:    'plugins:list',

  // Best-effort advisory: is this host still listed as active by the
  // reference index, or moved to its "graveyard"? See source-status.ts.
  SOURCE_STATUS_CHECK: 'source-status:check',

  // Events (main → renderer)
  EVENT_DOWNLOAD_PROGRESS:  'event:download-progress',
  EVENT_DOWNLOAD_COMPLETE:  'event:download-complete',
  EVENT_DOWNLOAD_ERROR:     'event:download-error',
  EVENT_ENGINE_STATUS:      'event:engine-status',
  EVENT_STALL:              'event:stall',
  EVENT_NETWORK_STATUS:     'event:network-status',
  EVENT_QUEUE_CHANGED:      'event:queue-changed',

  // Engine management
  ENGINE_CLEAR_RECORDS: 'engine:clear-records',
  ENGINE_UPDATE:        'engine:update',
  MENU_LABELS:          'menu:labels',
  MENU_POPUP:           'menu:popup',
  ENGINE_STATUS:        'engine:status',

  // Active count update (renderer → main, for badge/tray)
  DOWNLOADS_ACTIVE_COUNT: 'downloads:active-count',

  // Native notification
  NOTIFICATION_DOWNLOAD_COMPLETE: 'notification:download-complete',

  // Background
  BACKGROUND_GET_BING_IMAGE: 'background:get-bing-image',
  BACKGROUND_GET_BING_INFO:  'background:get-bing-info',
  WALLPAPER_ROTATE_NOW:      'wallpaper:rotate-now',
  EVENT_WALLPAPER_UPDATED:   'event:wallpaper-updated',

  // Clipboard watcher
  CLIPBOARD_WATCHER_START: 'clipboard:watch-start',
  CLIPBOARD_WATCHER_STOP: 'clipboard:watch-stop',
  EVENT_CLIPBOARD_URL: 'event:clipboard-url',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

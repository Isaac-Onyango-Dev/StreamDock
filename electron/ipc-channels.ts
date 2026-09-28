// Role: documented IPC channel constants shared by main and preload.

export const IPC = {
  // App
  APP_ENGINE_VERSION_WARNING:   'app:engine-version-warning',

  // Application update (electron-updater). The renderer owns the whole visible
  // surface — the main process only drives the phase and publishes it back, so
  // a silent download cannot happen the way it used to.
  UPDATE_GET_STATE: 'update:get-state',
  UPDATE_CHECK:     'update:check',
  UPDATE_DOWNLOAD:  'update:download',
  UPDATE_INSTALL:   'update:install',
  UPDATE_DISMISS:   'update:dismiss',

  // Window controls (renderer → main)
  WINDOW_MINIMIZE:          'window:minimize',
  WINDOW_MAXIMIZE_RESTORE:  'window:maximize-restore',
  WINDOW_CLOSE:             'window:close',

  // Window focus/blur events (main → renderer)
  WINDOW_FOCUSED:  'window:focused',
  WINDOW_BLURRED:  'window:blurred',

  // Dialog
  DIALOG_SELECT_DOWNLOAD_FOLDER: 'dialog:select-download-folder',

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
  DOWNLOAD_LIST:            'download:list',
  DOWNLOAD_REMOVE:          'download:remove',

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
  /** Ids the engine deleted; the renderer drops them and ignores late events. */
  EVENT_DOWNLOAD_REMOVED:   'event:download-removed',
  EVENT_UPDATE_STATE:       'event:update-state',

  // Engine management
  ENGINE_CLEAR_RECORDS: 'engine:clear-records',
  ENGINE_UPDATE:        'engine:update',
  MENU_LABELS:          'menu:labels',
  MENU_POPUP:           'menu:popup',
  ENGINE_STATUS:        'engine:status',

  // Background
  WALLPAPER_ROTATE_NOW:      'wallpaper:rotate-now',
  EVENT_WALLPAPER_UPDATED:   'event:wallpaper-updated',

  // Clipboard watcher
  CLIPBOARD_WATCHER_START: 'clipboard:watch-start',
  CLIPBOARD_WATCHER_STOP: 'clipboard:watch-stop',
  EVENT_CLIPBOARD_URL: 'event:clipboard-url',
} as const;


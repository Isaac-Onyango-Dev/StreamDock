// Role: StreamDock Electron main process — window lifecycle, IPC, logging, crash handling.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, nativeImage, Notification, Tray, net, protocol } from 'electron';
import type { OpenDialogOptions, MenuItemConstructorOptions } from 'electron';
import { existsSync, mkdirSync } from 'fs';
import { basename, join } from 'path';
import { pathToFileURL } from 'url';
import log from 'electron-log';
import { IPC } from './ipc-channels';
import { DownloadEngine, type DownloadRequest } from './download-engine';
import { analyzeUrl } from './url-router';
import { inspectUrl } from './playlist-inspector';
import { probeMediaTracks } from './media-track-probe';
import { probeStreamOptions } from './stream-options-probe';
import { getBinaryStatus, resolveUpdatableYtDlpCommand, resolveYtDlpCommand, resolvePluginDirs } from './binary-resolver';
import { toUserError } from './error-translator';
import {
  checkForUpdates,
  checkForUpdatesOnLaunch,
  dismissUpdate,
  downloadUpdate,
  getUpdateState,
  initAppUpdater,
  installUpdate,
} from './app-updater';
import { checkYtDlpVersion } from './version-checker';
import { installCrashReporter } from './crash-reporter';

import { initWallpaperManager, rotateNow, onSettingsChanged } from './wallpaper-manager';
import { checkSourceStatus } from './source-status';

// MUST be top-level, before app.whenReady()
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'wallpaper',
    privileges: {
      bypassCSP: true,
      secure: true,
      standard: true,
      supportFetchAPI: true,
    },
  },
]);

// Clipboard watcher
let clipboardWatcherInterval: NodeJS.Timeout | null = null;
let lastClipboardText = '';

function startClipboardWatcher(): void {
  if (clipboardWatcherInterval) return;
  
  lastClipboardText = clipboard.readText() || '';
  log.info('[clipboard] Watcher started');
  
  clipboardWatcherInterval = setInterval(() => {
    try {
      const text = clipboard.readText() || '';
      if (text !== lastClipboardText) {
        lastClipboardText = text;
        const urls = text.match(/https?:\/\/[^\s]+/g);
        if (urls && urls.length > 0) {
          const firstUrl = urls[0];
          log.info('[clipboard] URL detected:', firstUrl);
          // Send to all renderer windows
          BrowserWindow.getAllWindows().forEach((win) => {
            win.webContents.send(IPC.EVENT_CLIPBOARD_URL, { url: firstUrl, sourceText: text });
          });
        }
      }
    } catch (err) {
      log.warn('[clipboard] Watcher error:', err);
    }
  }, 1000);
}

function stopClipboardWatcher(): void {
  if (clipboardWatcherInterval) {
    clearInterval(clipboardWatcherInterval);
    clipboardWatcherInterval = null;
    log.info('[clipboard] Watcher stopped');
  }
}

// ── Configure electron-log (GOAL 9) ──────────────────────────────────────────
log.transports.file.level = 'debug';
log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
log.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : 'warn';

// Install crash reporter before anything else
installCrashReporter();

import { persistence, type AppSettings } from './persistence';

let mainWindow: BrowserWindow | null = null;
let appMenu: Menu | null = null;

/** Top-level menu labels, in order, for the in-window menu bar to render. */
function appMenuLabels(): string[] {
  if (!appMenu) return [];
  return appMenu.items.map((item) => item.label).filter(Boolean);
}

function showAboutDialog(): void {
  void dialog.showMessageBox(mainWindow ?? undefined!, {
    type: 'info',
    title: 'About StreamDock',
    message: `StreamDock ${app.getVersion()}`,
    detail: [
      'Video downloading and live-stream capture, built on yt-dlp.',
      '',
      `Electron ${process.versions.electron}`,
      `Chromium ${process.versions.chrome}`,
      `Node ${process.versions.node}`,
    ].join('\n'),
    buttons: ['OK'],
  });
}
let tray: Tray | null = null;
let engine: DownloadEngine;

function createWindow(): void {
  const isDev = !app.isPackaged || process.env.NODE_ENV === 'development';
  const iconPath = isDev
    ? join(app.getAppPath(), 'assets', 'icon.png')
    : join(process.resourcesPath, 'assets', 'icon.png');
  const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

  const isMac = process.platform === 'darwin';
  const titleBarStyle = isMac ? 'hiddenInset' : 'hidden';

  mainWindow = new BrowserWindow({
    width: 1240,
    height: 780,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0b1014',
    frame: false,
    titleBarStyle,
    ...(isMac ? { trafficLightPosition: { x: 16, y: 16 } } : {}),
    ...(icon && !icon.isEmpty() ? { icon } : {}),
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (mainWindow) initWallpaperManager(mainWindow);
  });

  // Forward focus/blur to renderer so AppChrome can apply the blur filter (REQ-27.4)
  mainWindow.on('focus', () => mainWindow?.webContents.send(IPC.WINDOW_FOCUSED));
  mainWindow.on('blur',  () => mainWindow?.webContents.send(IPC.WINDOW_BLURRED));

  // Tray-based close: hide instead of quit when downloads are active
  mainWindow.on('close', (e) => {
    const active = engine.activeCount();
    if (active > 0) {
      e.preventDefault();
      mainWindow?.hide();
      if (process.platform === 'win32') {
        tray?.displayBalloon({
          title: 'StreamDock is still running',
          content: `${active} download${active > 1 ? 's' : ''} continuing in background.`,
        });
      }
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  if (!app.isPackaged && process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://127.0.0.1:5173');
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/client/index.html'));
  }
}

function setupIpc(): void {
  // ── App ────────────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.APP_GET_VERSION, () => app.getVersion());

  // Application update. The renderer draws the whole flow (see
  // components/UpdateBanner.tsx); these only drive it. Each resolves to the
  // resulting state so a caller can await an outcome without subscribing first.
  ipcMain.handle(IPC.UPDATE_GET_STATE, () => getUpdateState());
  ipcMain.handle(IPC.UPDATE_CHECK, () => checkForUpdates(true));
  ipcMain.handle(IPC.UPDATE_DOWNLOAD, () => downloadUpdate());
  ipcMain.handle(IPC.UPDATE_INSTALL, () => installUpdate());
  ipcMain.handle(IPC.UPDATE_DISMISS, () => dismissUpdate());

  // ── Settings ───────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.SETTINGS_GET, () => persistence.getSettings());
  ipcMain.handle(IPC.SETTINGS_UPDATE, (_event, updates: Partial<AppSettings>) => {
    const next = persistence.updateSettings(updates);
    // Apply concurrent limit change immediately
    if (typeof updates.maxConcurrent === 'number') {
      engine.setMaxConcurrent(updates.maxConcurrent);
    }
    // Update interval timer if related settings changed
    if (
      updates.bingRefreshInterval !== undefined ||
      updates.backgroundMode !== undefined ||
      updates.backgroundImageUrl !== undefined
    ) {
      onSettingsChanged();
    }
    return next;
  });

  ipcMain.handle(IPC.PLUGINS_LIST, () => {
    try {
      const dirs = resolvePluginDirs();
      return dirs.map(dir => {
        // Assume plugin name is the folder name (e.g., 'plugins/foo' -> 'foo')
        const name = basename(dir);
        return { name, path: dir };
      });
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC.SOURCE_STATUS_CHECK, async (_event, host: string) => {
    try {
      return await checkSourceStatus(host);
    } catch {
      // Advisory-only lookup: any failure here must never surface as an
      // app error — just report "unknown" and let the caller say nothing.
      return 'unknown';
    }
  });

  // ── Dialog ─────────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.DIALOG_SELECT_DOWNLOAD_FOLDER, async () => {
    const options: OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] || null;
  });

  // ── Clipboard ──────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.CLIPBOARD_READ_TEXT, () => clipboard.readText());
  
  ipcMain.handle(IPC.CLIPBOARD_WATCHER_START, () => {
    startClipboardWatcher();
    return true;
  });
  
  ipcMain.handle(IPC.CLIPBOARD_WATCHER_STOP, () => {
    stopClipboardWatcher();
    return true;
  });

  // ── URL Analysis ───────────────────────────────────────────────────────────
  ipcMain.handle(IPC.URL_ANALYZE, (_event, url: string) => {
    try {
      return { success: true, data: analyzeUrl(url) };
    } catch (error) {
      return { success: false, error: toUserError(error) };
    }
  });
  ipcMain.handle(IPC.URL_INSPECT, async (_event, url: string) => {
    try {
      return { success: true, data: await inspectUrl(url) };
    } catch (error) {
      return { success: false, error: toUserError(error) };
    }
  });
  ipcMain.handle(IPC.MEDIA_PROBE_TRACKS, async (_event, payload: { pageUrl: string; manifestUrl?: string; referer?: string }) => {
    try {
      return { success: true, data: await probeMediaTracks(payload) };
    } catch (error) {
      return { success: false, error: toUserError(error) };
    }
  });
  ipcMain.handle(IPC.STREAM_OPTIONS_PROBE, async (_event, pageUrl: string) => {
    try {
      return await probeStreamOptions(pageUrl);
    } catch (error) {
      return { success: false, url: pageUrl, options: [], error: toUserError(error) };
    }
  });

  // ── Engine Status ──────────────────────────────────────────────────────────
  ipcMain.handle(IPC.ENGINE_STATUS, () => getBinaryStatus());
  // Legacy channel name
  ipcMain.handle(IPC.EVENT_ENGINE_STATUS, () => getBinaryStatus());

  // ── Download Lifecycle ─────────────────────────────────────────────────────
  ipcMain.handle(IPC.DOWNLOAD_START_VIDEO, async (_event, request: Omit<DownloadRequest, 'mode'>) => {
    try {
      const settings = persistence.getSettings();
      return engine.start({ ...request, mode: 'video', useCookies: settings.useCookies });
    } catch (e) { throw new Error(toUserError(e)); }
  });

  ipcMain.handle(IPC.DOWNLOAD_START_STREAM, async (_event, request: Omit<DownloadRequest, 'mode'>) => {
    try {
      const settings = persistence.getSettings();
      return engine.start({ ...request, mode: 'stream', useCookies: settings.useCookies });
    } catch (e) { throw new Error(toUserError(e)); }
  });

  ipcMain.handle(IPC.DOWNLOAD_CANCEL, (_event, id: string) => {
    try { engine.cancel(id); return true; } catch { return false; }
  });

  ipcMain.handle(IPC.DOWNLOAD_PAUSE, (_event, id: string) => {
    try { engine.pause(id); return true; } catch { return false; }
  });

  ipcMain.handle(IPC.DOWNLOAD_RESUME, (_event, id: string) => {
    try { engine.resume(id); return true; } catch { return false; }
  });

  ipcMain.handle(IPC.DOWNLOAD_RETRY, (_event, id: string) => {
    try { engine.retry(id); return true; } catch { return false; }
  });

  ipcMain.handle(IPC.DOWNLOAD_STOP_ALL, (_event, mode: 'pause' | 'cancel') => {
    try { engine.stopAll(mode ?? 'pause'); return true; } catch { return false; }
  });

  ipcMain.handle(IPC.DOWNLOAD_RESUME_ALL, () => {
    try { engine.resumeAll(); return true; } catch { return false; }
  });

  ipcMain.handle(IPC.DOWNLOAD_REORDER, (_event, id: string, newPosition: number) => {
    try { engine.reorder(id, newPosition); return true; } catch { return false; }
  });

  ipcMain.handle(IPC.DOWNLOAD_LIST, () => {
    try { return engine.list(); } catch { return []; }
  });

  // ── File Operations ────────────────────────────────────────────────────────
  ipcMain.handle(IPC.DOWNLOAD_OPEN_FILE, async (_event, filePath: string) => {
    try {
      if (!filePath || !existsSync(filePath)) throw new Error('File does not exist.');
      return await shell.openPath(filePath);
    } catch (e) { throw new Error(toUserError(e)); }
  });

  ipcMain.handle(IPC.DOWNLOAD_SHOW_IN_FOLDER, (_event, filePath: string) => {
    try {
      if (!filePath || !existsSync(filePath)) throw new Error('File does not exist.');
      shell.showItemInFolder(filePath);
      return true;
    } catch (e) { throw new Error(toUserError(e)); }
  });

  // ── Engine Management ──────────────────────────────────────────────────────
  ipcMain.handle(IPC.ENGINE_CLEAR_RECORDS, (_event, scope?: 'all' | 'completed' | 'failed' | 'cancelled') => {
    engine.clearRecords(scope ?? 'all');
    return true;
  });

  ipcMain.handle(IPC.ENGINE_UPDATE, async () => {
    try {
      const cmd = resolveUpdatableYtDlpCommand();
      const { execFile } = await import('child_process');

      // `yt-dlp -U` can take a while on a slow link and self-replaces its own
      // executable; the default execFile timeout would leave a half-swapped
      // binary behind, so allow real time for it.
      const updated = await new Promise<{ ok: boolean; output: string }>((resolve) => {
        execFile(
          cmd.command,
          [...cmd.args, '-U'],
          { windowsHide: true, timeout: 180_000, encoding: 'utf-8' },
          (error, stdout, stderr) => {
            const output = `${stdout ?? ''}${stderr ?? ''}`.trim();
            resolve({ ok: !error, output: output || (error ? String(error) : '') });
          },
        );
      });

      if (!updated.ok) {
        log.error('[engine-update] yt-dlp -U failed:', updated.output);
        return { success: false, error: toUserError(updated.output) };
      }

      // Report the version we actually ended up on rather than echoing yt-dlp's
      // update chatter. If the update was a no-op because the binary cannot
      // replace itself, this is what reveals it.
      const check = await checkYtDlpVersion(cmd.command, cmd.args);
      log.info(`[engine-update] yt-dlp now reports ${check.version ?? 'unknown'}`);

      if (check.version && check.isOutdated) {
        return {
          success: false,
          error:
            `The engine is still on ${check.version} after updating. ` +
            'Try running the update again, or reinstall StreamDock.',
        };
      }

      mainWindow?.webContents.send(IPC.APP_ENGINE_VERSION_WARNING, null);
      return {
        success: true,
        message: check.version ? `Download engine updated to ${check.version}.` : 'Download engine updated.',
      };
    } catch (e) {
      return { success: false, error: toUserError(e) };
    }
  });

  // ── Application menu (frameless window) ────────────────────────────────────
  ipcMain.handle(IPC.MENU_LABELS, () => appMenuLabels());

  ipcMain.handle(IPC.MENU_POPUP, (_event, label: string, x: number, y: number) => {
    if (!appMenu || !mainWindow) return false;
    const item = appMenu.items.find((entry) => entry.label === label);
    if (!item?.submenu) return false;
    // Round: Electron rejects fractional coordinates, and getBoundingClientRect
    // routinely returns them on a scaled display.
    item.submenu.popup({ window: mainWindow, x: Math.round(x), y: Math.round(y) });
    return true;
  });

  // ── Onboarding ─────────────────────────────────────────────────────────────
  // Previously only flipped an in-memory flag that nothing ever read and that
  // was lost on restart — calling markOnboarded() from the renderer had no
  // durable effect. Persist it like every other setting instead.
  ipcMain.handle(IPC.APP_MARK_ONBOARDED, () => {
    persistence.updateSettings({ hasOnboarded: true });
    return true;
  });

  // ── Window controls ────────────────────────────────────────────────────────
  ipcMain.handle(IPC.WINDOW_MINIMIZE, () => mainWindow?.minimize());
  ipcMain.handle(IPC.WINDOW_MAXIMIZE_RESTORE, () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.handle(IPC.WINDOW_CLOSE, () => {
    const active = engine.activeCount();
    if (active > 0) {
      mainWindow?.hide();
      if (process.platform === 'win32') {
        tray?.displayBalloon({
          title: 'StreamDock is still running',
          content: `${active} download${active > 1 ? 's' : ''} continuing in background.`,
        });
      }
    } else {
      mainWindow?.close();
    }
  });

  // ── Native Notification ────────────────────────────────────────────────────
  ipcMain.handle(IPC.NOTIFICATION_DOWNLOAD_COMPLETE, (_event, { title }: { title: string }) => {
    if (Notification.isSupported()) {
      const n = new Notification({ title: 'Download Complete', body: title });
      n.on('click', () => {
        mainWindow?.show();
        mainWindow?.focus();
        mainWindow?.webContents.send('menu:focus-tab', 'transfers');
      });
      n.show();
    }
  });

  // ── Background ──────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.WALLPAPER_ROTATE_NOW, async () => {
    const url = await rotateNow();
    if (url) {
      persistence.updateSettings({ backgroundImageUrl: url });
    }
    return url;
  });

  // ── Active Count / Tray Badge ──────────────────────────────────────────────
  ipcMain.handle(IPC.DOWNLOADS_ACTIVE_COUNT, (_event, count: number) => {
    if (process.platform === 'darwin') {
      app.dock?.setBadge(count > 0 ? count.toString() : '');
    } else {
      tray?.setToolTip(`StreamDock - ${count > 0 ? count + ' active downloads' : 'Idle'}`);
    }
  });
}

function setupTray(): void {
  const isDev = !app.isPackaged || process.env.NODE_ENV === 'development';
  const iconPath = isDev
    ? join(app.getAppPath(), 'assets', 'icon.png')
    : join(process.resourcesPath, 'assets', 'icon.png');
    
  if (!existsSync(iconPath)) return;
  
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));
  tray.setToolTip('StreamDock - Idle');
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open StreamDock', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Pause All', click: () => engine.stopAll('pause') },
    { label: 'Resume All', click: () => engine.resumeAll() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
  
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow?.isVisible()) mainWindow.focus();
    else mainWindow?.show();
  });
}

function buildAppMenu(): void {
  const isMac = process.platform === 'darwin';

  /*
   * The app-name menu is a macOS convention, and on macOS the system menu bar
   * renders it as the bold application title. On Windows and Linux there is no
   * system menu bar for a frameless window, so the custom titlebar renders the
   * top-level labels itself — and this entry showed up there as a second, plain
   * "StreamDock" sitting immediately beside the gradient wordmark.
   *
   * It is dropped rather than relabelled because every item in it already
   * exists elsewhere: About in Help, Quit as File > Exit, and Open Download
   * Folder as File > Choose Download Folder (both send the same IPC message;
   * only the redundant Ctrl+O alias for Ctrl+D goes away with it).
   */
  const appNameMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: 'StreamDock',
          submenu: [
            { label: 'About StreamDock', role: 'about' },
            { type: 'separator' },
            { label: 'Open Download Folder', accelerator: 'CmdOrCtrl+O', click: openDownloadFolder },
            { type: 'separator' },
            { label: 'Quit StreamDock', accelerator: 'CmdOrCtrl+Q', role: 'quit' },
          ],
        },
      ]
    : [];

  const template: MenuItemConstructorOptions[] = [
    ...appNameMenu,
    {
      label: 'File',
      submenu: [
        { label: 'Capture', accelerator: 'CmdOrCtrl+N', click: focusTab('capture') },
        { label: 'Downloads', accelerator: 'CmdOrCtrl+T', click: focusTab('transfers') },
        { label: 'Settings', accelerator: 'CmdOrCtrl+Shift+H', click: focusTab('settings') },
        { type: 'separator' },
        { label: 'Choose Download Folder…', accelerator: 'CmdOrCtrl+D', click: openDownloadFolder },
        { type: 'separator' },
        { label: 'Pause All Downloads', accelerator: 'CmdOrCtrl+P', click: () => engine.stopAll('pause') },
        { label: 'Resume All Downloads', accelerator: 'CmdOrCtrl+Shift+P', click: () => engine.resumeAll() },
        { type: 'separator' },
        isMac ? { label: 'Close Window', role: 'close' } : { label: 'Exit', role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Paste URL', accelerator: 'CmdOrCtrl+V', click: pasteClipboard },
        { type: 'separator' },
        { label: 'Undo', role: 'undo' },
        { label: 'Redo', role: 'redo' },
        { type: 'separator' },
        { label: 'Cut', role: 'cut' },
        { label: 'Copy', role: 'copy' },
        { label: 'Paste', role: 'paste' },
        { label: 'Select All', role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', role: 'reload' },
        { label: 'Toggle Developer Tools', accelerator: 'F12', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', role: 'zoomIn' },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
        { type: 'separator' },
        { label: 'Full Screen', role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'About StreamDock', click: showAboutDialog },
        // Routes into the same in-app banner the launch check uses rather than
        // a native dialog: one update surface, so progress cannot go missing
        // from one of them the way it did when the download had no UI at all.
        { label: 'Check for Updates\u2026', click: () => void checkForUpdates(true) },
        { type: 'separator' },
        { label: 'Open Logs Folder', click: () => shell.openPath(app.getPath('userData')) },
        { type: 'separator' },
        { label: 'StreamDock on GitHub', click: () => shell.openExternal('https://github.com/Isaac-Onyango-Dev/StreamDock') },
        { label: 'Report Issue', click: () => shell.openExternal('https://github.com/Isaac-Onyango-Dev/StreamDock/issues') },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);

  // The window is frameless (`frame: false`), and on Windows/Linux that means
  // the native application menu bar is never drawn — which is why the app
  // appeared to have no File/Edit/Help menu at all even though this whole
  // template already existed. The accelerators below still worked; nothing was
  // discoverable. Keep the native menu as the single source of truth and let
  // the custom titlebar pop its submenus up in place (see IPC.MENU_POPUP).
  appMenu = menu;
  Menu.setApplicationMenu(menu);
  log.info(`[menu] Top-level menus: ${appMenuLabels().join(', ')}`);

  function openDownloadFolder(): void {
    mainWindow?.webContents.send('menu:open-download-folder');
  }
  function pasteClipboard(): void {
    mainWindow?.webContents.send('menu:paste-clipboard');
  }
  function focusTab(tab: string) {
    return () => mainWindow?.webContents.send('menu:focus-tab', tab);
  }
}

// ── App close handling (GOAL 6): prompt if downloads are active ──────────────
//
// Module-scoped rather than local to setupBeforeQuit() because the updater also
// needs to set it: `quitAndInstall` spawns the installer and *then* quits, so if
// this handler intercepted that quit to ask about active downloads, answering
// "Keep Downloading" would leave an installer running against a live app.
let isQuitting = false;

/**
 * Shut down cleanly ahead of an update install.
 *
 * `engine.shutdown()` pauses every running download and saves the queue, so they
 * resume after the restart rather than being lost — which is what lets the quit
 * go through unprompted.
 */
function prepareQuitForUpdate(): void {
  if (isQuitting) return;
  log.info('[updater] pausing downloads and quitting to install');
  engine.shutdown();
  isQuitting = true;
}

function setupBeforeQuit(): void {
  app.on('before-quit', async (e) => {
    if (isQuitting) return;

    const active = engine.activeCount();
    if (active === 0) {
      engine.shutdown();
      return;
    }

    e.preventDefault();

    const response = await dialog.showMessageBox(mainWindow!, {
      type: 'question',
      title: 'Downloads Active',
      message: `${active} download${active > 1 ? 's are' : ' is'} active.`,
      detail: 'What would you like to do?',
      buttons: ['Pause & Exit', 'Cancel Downloads & Exit', 'Keep Downloading'],
      defaultId: 0,
      cancelId: 2,
    });

    if (response.response === 2) return; // Keep downloading

    if (response.response === 1) {
      engine.stopAll('cancel');
    } else {
      engine.shutdown(); // Pauses all and saves state
    }

    isQuitting = true;
    app.quit();
  });
}

app.whenReady().then(async () => {
  log.info(`Starting StreamDock v${app.getVersion()}`);

  // Configure electron-log file path
  log.transports.file.resolvePathFn = () => join(app.getPath('userData'), 'streamdock.log');

  engine = new DownloadEngine(() => mainWindow);

  // Apply saved settings
  const settings = persistence.getSettings();
  if (settings.maxConcurrent) engine.setMaxConcurrent(settings.maxConcurrent);
  if (settings.clipboardWatcher) startClipboardWatcher();

  buildAppMenu();
  setupIpc();
  setupTray();
  setupBeforeQuit();
  // Core app logic (window, IPC, menu, tray) is now fully up regardless of what
  // happens below. The wallpaper feature is cosmetic and must never be able to
  // prevent the window from ever appearing.
  createWindow();

  // The updater reports into the renderer, so it is wired after the window is
  // created. The window is read through a getter rather than captured, so a
  // reload or a re-created window still receives state. Fire-and-forget: a
  // GitHub outage must never delay or block startup.
  initAppUpdater({ window: () => mainWindow, prepareForQuit: prepareQuitForUpdate });
  checkForUpdatesOnLaunch();

  // Wallpaper cache dir + custom protocol handler. Deliberately isolated in its
  // own try/catch and run AFTER createWindow(): previously this block ran FIRST,
  // before the window was created at all. Any throw here (a locked/inaccessible
  // userData path, disk full, AV interference, etc.) became an unhandled promise
  // rejection that halted this entire async callback -- createWindow() below it
  // never ran, no window ever appeared, and the process just sat there with
  // nothing visible: indistinguishable from "the app is bricked" to a user, for
  // a failure that has nothing to do with core download functionality. Timing is
  // still safe here: initWallpaperManager() (called from createWindow()'s
  // 'ready-to-show' handler, which only fires after the window's initial page
  // load completes) is the first thing that can send a renderer-facing
  // 'wallpaper://' URL, and that happens well after this synchronous
  // registration below.
  try {
    const CACHE_DIR = join(app.getPath('userData'), 'wallpapers');
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }

    protocol.handle('wallpaper', async (request) => {
      try {
        const url = new URL(request.url);
        const raw = decodeURIComponent(url.hostname || url.pathname.replace(/^\/+/, ''));
        const filename = raw.replace(/[/\\]/g, '');

        if (!filename || filename !== raw || filename.includes('..')) {
          console.error(`[wallpaper] Invalid wallpaper URL: ${request.url}`);
          return new Response('Invalid wallpaper URL', { status: 400 });
        }

        const filePath = join(CACHE_DIR, filename);

        if (!existsSync(filePath)) {
          console.error(`[wallpaper] File not found: ${filePath}`);
          return new Response('Not found', { status: 404 });
        }

        // CRITICAL FIX: use pathToFileURL, not string concatenation
        const fileUrl = pathToFileURL(filePath).toString();
        return net.fetch(fileUrl);
      } catch (err) {
        // A failure serving one wallpaper request must degrade to a plain
        // 404/500 response, never crash the main process.
        console.error('[wallpaper] protocol handler request failed:', err);
        return new Response('Internal error', { status: 500 });
      }
    });
  } catch (err) {
    log.error(
      '[wallpaper] Failed to initialize wallpaper cache/protocol handler -- ' +
      'background wallpapers will be unavailable this session; the solid-color ' +
      'background and every other app feature are unaffected:',
      err,
    );
  }

  // Version check (GOAL 3) — run after window ready
  try {
    const ytDlpCmd = resolveYtDlpCommand();
    const versionResult = await checkYtDlpVersion(ytDlpCmd.command, ytDlpCmd.args);
    if (versionResult.isOutdated && versionResult.warning) {
      // Delay to ensure renderer is ready
      setTimeout(() => {
        mainWindow?.webContents.send(IPC.APP_ENGINE_VERSION_WARNING, versionResult.warning);
      }, 2_000);
    }
    log.info(`[startup] yt-dlp version check: ${versionResult.version ?? 'unknown'}`);
  } catch (err) {
    log.warn('[startup] Could not check yt-dlp version:', err);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

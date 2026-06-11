// Role: StreamDock Electron main process — window lifecycle, IPC, logging, crash handling.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, nativeImage, Notification, Tray } from 'electron';
import type { OpenDialogOptions, MenuItemConstructorOptions } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import log from 'electron-log';
import { IPC } from './ipc-channels';
import { DownloadEngine, type DownloadRequest } from './download-engine';
import { analyzeUrl } from './url-router';
import { inspectUrl } from './playlist-inspector';
import { probeMediaTracks } from './media-track-probe';
import { getBinaryStatus, resolveUpdatableYtDlpCommand, resolveYtDlpCommand } from './binary-resolver';
import { toUserError } from './error-translator';
import { checkYtDlpVersion } from './version-checker';
import { installCrashReporter } from './crash-reporter';

// ── Configure electron-log (GOAL 9) ──────────────────────────────────────────
log.transports.file.level = 'debug';
log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
log.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : 'warn';

// Install crash reporter before anything else
installCrashReporter();

import { persistence, type AppSettings } from './persistence';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let engine: DownloadEngine;
let hasOnboarded = false;

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

  mainWindow.once('ready-to-show', () => mainWindow?.show());

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

  // ── Settings ───────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.SETTINGS_GET, () => persistence.getSettings());
  ipcMain.handle(IPC.SETTINGS_UPDATE, (_event, updates: Partial<AppSettings>) => {
    const next = persistence.updateSettings(updates);
    // Apply concurrent limit change immediately
    if (typeof updates.maxConcurrent === 'number') {
      engine.setMaxConcurrent(updates.maxConcurrent);
    }
    return next;
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
      return new Promise((resolve) => {
        execFile(cmd.command, [...cmd.args, '-U'], { windowsHide: true }, (error, stdout) => {
          if (error) resolve({ success: false, error: toUserError(error) });
          else resolve({ success: true, message: stdout || `Updated ${cmd.type === 'python' ? 'python yt-dlp module' : cmd.command}` });
        });
      });
    } catch (e) {
      return { success: false, error: toUserError(e) };
    }
  });

  // ── Onboarding ─────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.APP_MARK_ONBOARDED, () => {
    hasOnboarded = true;
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

  const template: MenuItemConstructorOptions[] = [
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
        { label: 'Open Logs Folder', click: () => shell.openPath(app.getPath('userData')) },
        { type: 'separator' },
        { label: 'Report Issue', click: () => shell.openExternal('https://github.com/Isaac-Onyango-Dev/StreamDock/issues') },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

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
function setupBeforeQuit(): void {
  let isQuitting = false;

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
  hasOnboarded = !!settings.hasOnboarded;

  buildAppMenu();
  setupIpc();
  setupTray();
  setupBeforeQuit();
  createWindow();

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

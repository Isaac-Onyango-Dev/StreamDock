import { vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      const paths: Record<string, string> = {
        userData: '/tmp/test-user-data',
        downloads: '/tmp/test-downloads',
      };
      return paths[name] || '/tmp/test';
    }),
    getVersion: vi.fn(() => '1.0.0-test'),
    getAppPath: vi.fn(() => '/tmp/test-app'),
    isPackaged: false,
    on: vi.fn(),
    quit: vi.fn(),
  },
  BrowserWindow: vi.fn().mockImplementation(() => ({
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    webContents: {
      send: vi.fn(),
      on: vi.fn(),
      executeJavaScript: vi.fn(),
      setAudioMuted: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      setUserAgent: vi.fn(),
    },
    on: vi.fn(),
    once: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    close: vi.fn(),
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    isMaximized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    focus: vi.fn(),
    destroy: vi.fn(),
    setToolTip: vi.fn(),
    displayBalloon: vi.fn(),
  })),
  clipboard: {
    readText: vi.fn(() => ''),
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showMessageBox: vi.fn(),
  },
  shell: {
    openPath: vi.fn(),
    showItemInFolder: vi.fn(),
    openExternal: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
  },
  Menu: {
    buildFromTemplate: vi.fn(() => ({})),
    setApplicationMenu: vi.fn(),
  },
  Tray: vi.fn().mockImplementation(() => ({
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    on: vi.fn(),
  })),
  nativeImage: {
    createFromPath: vi.fn(() => ({ resize: vi.fn(() => ({})), isEmpty: vi.fn(() => false) })),
  },
  Notification: {
    isSupported: vi.fn(() => true),
  },
  session: {
    fromPartition: vi.fn(() => ({
      webRequest: {
        onBeforeRequest: vi.fn(),
        onBeforeSendHeaders: vi.fn(),
        onHeadersReceived: vi.fn(),
      },
      clearStorageData: vi.fn(),
    })),
  },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  },
  net: {
    request: vi.fn(),
    fetch: vi.fn(),
  },
}));

vi.mock('electron-log', () => ({
  default: {
    transports: {
      file: { level: 'debug', maxSize: 5 * 1024 * 1024 },
      console: { level: 'warn' },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Node 19+ exposes `globalThis.crypto` as a non-configurable getter-only accessor
// (the Web Crypto API), so `global.crypto = {...}` throws
// "TypeError: Cannot set property crypto of #<Object> which has only a getter"
// at module-eval time — which was silently killing every single test file
// (all six suites failed to even load; vitest reported "0 tests" for each).
// Stub randomUUID on the existing crypto object instead of replacing it.
vi.stubGlobal('crypto', {
  ...globalThis.crypto,
  randomUUID: () => 'test-uuid-' + Math.random().toString(36).slice(2),
});

HTMLCanvasElement.prototype.getContext = vi.fn();
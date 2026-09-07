// Role: application auto-update against GitHub Releases (electron-updater).
//
// Pairs with electron-builder's `publish: github` block in package.json, which
// is what makes the build emit the `latest.yml` manifest electron-updater reads.
// Before that block existed the release workflow was already trying to upload
// `latest.yml` — electron-builder simply never generated one, so the upload
// matched nothing and silently produced a release no client could update from.
import { app, BrowserWindow, dialog, shell } from 'electron';
import log from 'electron-log';
import type { UpdateInfo } from 'electron-updater';
import updaterPkg from 'electron-updater';

const RELEASES_URL = 'https://github.com/Isaac-Onyango-Dev/StreamDock/releases/latest';

// electron-updater is CommonJS with a default export; destructuring keeps this
// working under the esbuild ESM->CJS bundling the main process uses.
const { autoUpdater } = updaterPkg;

export type UpdateCheckResult =
  | { status: 'available'; version: string }
  | { status: 'up-to-date'; version: string }
  | { status: 'unsupported'; reason: string }
  | { status: 'error'; error: string };

let configured = false;
let checkInFlight: Promise<UpdateCheckResult> | null = null;

/**
 * Updates only work from a packaged, installed build.
 *
 * In dev there is no app-update.yml and no installer to hand off to, and
 * electron-updater throws rather than no-oping — so callers need to be able to
 * say "not supported here" instead of surfacing that as a failure.
 */
function unsupportedReason(): string | null {
  if (!app.isPackaged) return 'Updates are only available in an installed build of StreamDock.';
  return null;
}

function configure(): void {
  if (configured) return;
  configured = true;

  autoUpdater.logger = log;
  // Download only on explicit consent — silently pulling ~300MB in the
  // background on someone's connection is not ours to decide.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (error) => {
    log.error('[updater] error:', error);
  });
  autoUpdater.on('download-progress', (progress) => {
    log.info(`[updater] downloading: ${Math.round(progress.percent)}%`);
  });
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    log.info(`[updater] update ${info.version} downloaded`);
  });
}

/** Check GitHub Releases for a newer version. Never throws. */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const unsupported = unsupportedReason();
  if (unsupported) return { status: 'unsupported', reason: unsupported };

  // Coalesce concurrent checks — the launch check and a menu click can easily
  // overlap, and electron-updater does not like two in flight at once.
  if (checkInFlight) return checkInFlight;

  configure();

  checkInFlight = (async (): Promise<UpdateCheckResult> => {
    try {
      const result = await autoUpdater.checkForUpdates();
      const current = app.getVersion();
      if (!result?.updateInfo) return { status: 'up-to-date', version: current };

      const latest = result.updateInfo.version;
      if (latest && latest !== current) return { status: 'available', version: latest };
      return { status: 'up-to-date', version: current };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('[updater] check failed:', message);
      return { status: 'error', error: message };
    } finally {
      checkInFlight = null;
    }
  })();

  return checkInFlight;
}

/**
 * Download the pending update and offer to restart into it.
 * Returns true when the update was downloaded and is staged for install.
 */
export async function downloadAndInstall(parent?: BrowserWindow | null): Promise<boolean> {
  if (unsupportedReason()) return false;
  configure();

  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    log.error('[updater] download failed:', error);
    const message = error instanceof Error ? error.message : String(error);
    await dialog.showMessageBox(parent ?? undefined!, {
      type: 'error',
      title: 'Update failed',
      message: 'StreamDock could not download the update.',
      detail: `${message}\n\nYou can download it manually from the releases page instead.`,
      buttons: ['Open Releases Page', 'Close'],
      defaultId: 0,
      cancelId: 1,
    }).then((res) => {
      if (res.response === 0) void shell.openExternal(RELEASES_URL);
    });
    return false;
  }

  const { response } = await dialog.showMessageBox(parent ?? undefined!, {
    type: 'info',
    title: 'Update ready',
    message: 'The update has been downloaded.',
    detail: 'StreamDock needs to restart to finish installing it.',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });

  if (response === 0) {
    // isSilent=false so the NSIS installer shows progress; isForceRunAfter so
    // the app comes back up rather than leaving the user staring at a closed window.
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
  }
  return true;
}

/**
 * Menu-driven check: always reports an outcome, including "you're up to date",
 * because a Help menu item that silently does nothing reads as broken.
 */
export async function checkForUpdatesInteractive(parent?: BrowserWindow | null): Promise<void> {
  const result = await checkForUpdates();

  if (result.status === 'available') {
    const { response } = await dialog.showMessageBox(parent ?? undefined!, {
      type: 'info',
      title: 'Update available',
      message: `StreamDock ${result.version} is available.`,
      detail: `You are running ${app.getVersion()}.`,
      buttons: ['Download & Install', 'View Release Notes', 'Not Now'],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 0) await downloadAndInstall(parent);
    else if (response === 1) void shell.openExternal(RELEASES_URL);
    return;
  }

  if (result.status === 'up-to-date') {
    await dialog.showMessageBox(parent ?? undefined!, {
      type: 'info',
      title: 'No updates',
      message: `StreamDock ${result.version} is up to date.`,
      buttons: ['OK'],
    });
    return;
  }

  if (result.status === 'unsupported') {
    await dialog.showMessageBox(parent ?? undefined!, {
      type: 'info',
      title: 'Check for updates',
      message: result.reason,
      detail: 'You can always see the latest release on GitHub.',
      buttons: ['Open Releases Page', 'Close'],
      defaultId: 0,
      cancelId: 1,
    }).then((res) => {
      if (res.response === 0) void shell.openExternal(RELEASES_URL);
    });
    return;
  }

  await dialog.showMessageBox(parent ?? undefined!, {
    type: 'error',
    title: 'Check for updates',
    message: 'Could not check for updates.',
    detail: result.error,
    buttons: ['Open Releases Page', 'Close'],
    defaultId: 0,
    cancelId: 1,
  }).then((res) => {
    if (res.response === 0) void shell.openExternal(RELEASES_URL);
  });
}

/**
 * Launch check: quiet unless there is genuinely something to offer, and never
 * allowed to interfere with startup — an update server hiccup must not be able
 * to affect the app booting.
 */
export function checkForUpdatesOnLaunch(parent?: BrowserWindow | null): void {
  if (unsupportedReason()) return;

  // Deliberately delayed: competing with window paint and the engine version
  // check for bandwidth at t=0 makes launch feel slower for no benefit.
  setTimeout(() => {
    void checkForUpdates()
      .then(async (result) => {
        if (result.status !== 'available') return;
        const { response } = await dialog.showMessageBox(parent ?? undefined!, {
          type: 'info',
          title: 'Update available',
          message: `StreamDock ${result.version} is available.`,
          detail: `You are running ${app.getVersion()}.`,
          buttons: ['Download & Install', 'Later'],
          defaultId: 0,
          cancelId: 1,
        });
        if (response === 0) await downloadAndInstall(parent);
      })
      .catch((error) => log.warn('[updater] launch check failed:', error));
  }, 8_000);
}

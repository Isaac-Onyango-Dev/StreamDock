// Role: application auto-update against GitHub Releases (electron-updater).
//
// Pairs with electron-builder's `publish: github` block in package.json, which
// is what makes the build emit the `latest.yml` manifest electron-updater reads.
// Before that block existed the release workflow was already trying to upload
// `latest.yml` — electron-builder simply never generated one, so the upload
// matched nothing and silently produced a release no client could update from.
//
// Why there are no dialogs here any more
// --------------------------------------
// This module used to run the whole flow through `dialog.showMessageBox`. The
// check and the install were real, but the several minutes between "Download &
// Install" and "Update ready" had no user interface at all: the modal closed and
// a 300MB installer transferred in complete silence, with `download-progress`
// going only to the log file. The renderer owns the update surface now and this
// module only publishes state into it, so progress is visible by construction
// rather than by someone remembering to add a second UI beside the first.
import { app, BrowserWindow, shell } from 'electron';
import log from 'electron-log';
import type { UpdateInfo } from 'electron-updater';
import updaterPkg from 'electron-updater';
import { IPC } from './ipc-channels';
import { UPDATE_FALLBACK_URL, type UpdateState } from '../shared/update-state';

// electron-updater is CommonJS with a default export; destructuring keeps this
// working under the esbuild ESM->CJS bundling the main process uses.
const { autoUpdater } = updaterPkg;

type WindowGetter = () => BrowserWindow | null;

let configured = false;
let getWindow: WindowGetter = () => null;
let prepareQuit: () => void = () => {};
let checkInFlight: Promise<UpdateState> | null = null;
let downloadInFlight = false;
let state: UpdateState = { phase: 'idle' };

/**
 * Wire the updater to the window it reports into and to the app's own shutdown.
 *
 * `prepareForQuit` matters: `before-quit` intercepts a quit while downloads are
 * running and asks the user what to do. An update install must not be answered
 * with that question — the installer has already been handed control by the time
 * it would appear — so the caller shuts the engine down cleanly first (which
 * pauses and saves, so downloads resume after the restart) and lets the quit
 * through.
 */
export function initAppUpdater(options: {
  window: WindowGetter;
  prepareForQuit: () => void;
}): void {
  getWindow = options.window;
  prepareQuit = options.prepareForQuit;
}

/** The latest state, for a renderer that mounted after it was published. */
export function getUpdateState(): UpdateState {
  return state;
}

function publish(next: Partial<UpdateState> & { phase: UpdateState['phase'] }): void {
  state = { currentVersion: app.getVersion(), ...next };
  getWindow()?.webContents.send(IPC.EVENT_UPDATE_STATE, state);
}

/**
 * Report a failure and hand the user somewhere they can actually finish.
 *
 * The state is published *before* the browser opens, so the explanation is
 * already on screen when the other window appears. A redirect nobody asked for
 * and nobody was told about is indistinguishable from the app losing the click.
 */
async function failToFallback(detail: string, interactive: boolean): Promise<void> {
  log.error(`[updater] ${detail}`);

  if (!interactive) {
    // A background check that could not reach GitHub is not worth interrupting
    // anyone about, and certainly not by opening a browser at them.
    publish({ phase: 'error', detail, interactive: false });
    return;
  }

  publish({ phase: 'error', detail, interactive: true, openedFallback: true });
  try {
    await shell.openExternal(UPDATE_FALLBACK_URL);
  } catch (error) {
    // The banner names the URL in full either way, so there is still a route
    // forward; what has to change is the claim that it was already opened.
    log.warn('[updater] could not open the download page:', error);
    publish({ phase: 'error', detail, interactive: true, openedFallback: false });
  }
}

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
    publish({
      phase: 'downloading',
      version: state.version,
      percent: Math.max(0, Math.min(100, progress.percent)),
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
      interactive: state.interactive,
    });
  });
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    log.info(`[updater] update ${info.version} downloaded`);
    publish({ phase: 'ready', version: info.version, interactive: state.interactive });
  });
}

/**
 * Check GitHub Releases for a newer version. Never throws.
 *
 * `interactive` says whether a person asked. It decides whether a quiet outcome
 * ("up to date") or a failure is put in front of them at all — see
 * shouldSurface() in shared/update-state.ts.
 */
export async function checkForUpdates(interactive = false): Promise<UpdateState> {
  const unsupported = unsupportedReason();
  if (unsupported) {
    publish({ phase: 'unsupported', detail: unsupported, interactive });
    return state;
  }

  // Coalesce concurrent checks — the launch check and a menu click can easily
  // overlap, and electron-updater does not like two in flight at once.
  if (checkInFlight) return checkInFlight;

  configure();
  publish({ phase: 'checking', interactive });

  checkInFlight = (async (): Promise<UpdateState> => {
    try {
      const result = await autoUpdater.checkForUpdates();

      // `isUpdateAvailable` is electron-updater's own semver comparison. This
      // used to be `latest !== current`, a string inequality, which reported an
      // update whenever the two differed in *any* direction — so a packaged
      // build running ahead of the published release offered itself a downgrade.
      if (result?.isUpdateAvailable && result.updateInfo?.version) {
        publish({ phase: 'available', version: result.updateInfo.version, interactive });
      } else {
        publish({ phase: 'up-to-date', version: app.getVersion(), interactive });
      }
      return state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await failToFallback(`Could not check for updates: ${message}`, interactive);
      return state;
    } finally {
      checkInFlight = null;
    }
  })();

  return checkInFlight;
}

/**
 * Download the pending update in place, reporting progress as it goes.
 *
 * Pressing this is always a deliberate act, so the flow is interactive from here
 * on even when it was the unprompted launch check that surfaced the offer.
 */
export async function downloadUpdate(): Promise<UpdateState> {
  const unsupported = unsupportedReason();
  if (unsupported) {
    publish({ phase: 'unsupported', detail: unsupported, interactive: true });
    return state;
  }
  if (downloadInFlight) return state;

  configure();
  downloadInFlight = true;
  publish({ phase: 'downloading', version: state.version, percent: 0, interactive: true });

  try {
    await autoUpdater.downloadUpdate();
    // 'update-downloaded' normally publishes the 'ready' phase. This covers the
    // case where the installer was already on disk from an earlier run and the
    // event therefore never fires.
    if (state.phase === 'downloading') {
      publish({ phase: 'ready', version: state.version, interactive: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failToFallback(`Could not download the update: ${message}`, true);
  } finally {
    downloadInFlight = false;
  }

  return state;
}

/** Restart into the downloaded installer. */
export function installUpdate(): UpdateState {
  if (state.phase !== 'ready') return state;

  publish({ phase: 'installing', version: state.version, interactive: true });
  prepareQuit();

  // isSilent=false so the NSIS installer shows progress; isForceRunAfter so the
  // app comes back up rather than leaving the user staring at a closed window.
  // Deferred a tick so the 'installing' state reaches the renderer and paints
  // before the window starts tearing down.
  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void failToFallback(`Could not start the installer: ${message}`, true);
    }
  });

  return state;
}

/** Put the banner away. */
export function dismissUpdate(): UpdateState {
  // An install already handed off cannot be dismissed; anything else can.
  if (state.phase === 'installing') return state;
  publish({ phase: 'idle' });
  return state;
}

/**
 * Launch check: quiet unless there is genuinely something to offer, and never
 * allowed to interfere with startup — an update server hiccup must not be able
 * to affect the app booting.
 */
export function checkForUpdatesOnLaunch(): void {
  if (unsupportedReason()) return;

  // Deliberately delayed: competing with window paint and the engine version
  // check for bandwidth at t=0 makes launch feel slower for no benefit.
  setTimeout(() => {
    void checkForUpdates(false).catch((error) =>
      log.warn('[updater] launch check failed:', error),
    );
  }, 8_000);
}

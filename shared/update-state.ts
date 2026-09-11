// Role: the single model for the in-app application-update flow.
//
// Lives in shared/ for the same reason subtitle-args.ts does. The main process
// drives the phase as electron-updater progresses and the renderer draws it, so
// both sides need the same vocabulary — and this repo has twice shipped a bug
// caused by two copies of one decision drifting (the changelog parser, the
// language classifier). The wording a user sees when an update fails is exactly
// the kind of string that would drift if each process owned its own copy.

/**
 * Where a user is sent when the in-app updater genuinely cannot finish.
 *
 * Deliberately the project site, and never a GitHub releases or tags page. A
 * releases listing asks a non-technical user to pick the right file out of a
 * list that also contains blockmaps and update manifests, and a tags page
 * offers no installer at all. The site has one download button per platform.
 */
export const UPDATE_FALLBACK_URL = 'https://isaac-onyango-dev.github.io/StreamDock/';

export type UpdatePhase =
  /** Nothing to say. The banner is not rendered. */
  | 'idle'
  /** A check is in flight. */
  | 'checking'
  /** A newer version exists and is waiting for consent to download. */
  | 'available'
  /** The installer is transferring. `percent` is meaningful in this phase only. */
  | 'downloading'
  /** The installer is on disk and staged; restarting applies it. */
  | 'ready'
  /** Restart requested; the installer has been handed control. */
  | 'installing'
  | 'up-to-date'
  /** Running unpackaged, where there is no installer to hand off to. */
  | 'unsupported'
  /** The in-app path failed. `detail` says how. */
  | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  /** The version being offered, downloaded or installed. */
  version?: string;
  /** The version currently running. */
  currentVersion?: string;
  /** 0-100. Only set while downloading. */
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  /** Why an 'error' or 'unsupported' phase happened, in the engine's own words. */
  detail?: string;
  /** True once the fallback download page has been opened in the browser. */
  openedFallback?: boolean;
  /**
   * Whether a person asked for this. The launch check runs on its own and must
   * stay quiet unless it has something to offer; a menu click must always
   * report an outcome, because a menu item that silently does nothing reads as
   * broken.
   */
  interactive?: boolean;
}

export const IDLE_UPDATE_STATE: UpdateState = { phase: 'idle' };

export interface UpdateDescription {
  headline: string;
  detail?: string;
  tone: 'info' | 'progress' | 'success' | 'error';
}

/**
 * The user-facing wording for a phase.
 *
 * Every failure says what happened and what is being done about it. A redirect
 * the user did not ask for and is not told about is indistinguishable from the
 * app losing their click.
 */
function terminate(text: string | undefined): string {
  if (!text) return '';
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function describeUpdateState(state: UpdateState): UpdateDescription {
  const version = state.version ?? '';
  const current = state.currentVersion ?? '';

  switch (state.phase) {
    case 'checking':
      return { headline: 'Checking for updates…', tone: 'progress' };

    case 'available':
      return {
        headline: `StreamDock ${version} is available.`,
        detail: current ? `You are running ${current}.` : undefined,
        tone: 'info',
      };

    case 'downloading':
      return {
        headline: `Downloading StreamDock ${version}…`,
        detail: 'Keep StreamDock open. You can carry on using it while this finishes.',
        tone: 'progress',
      };

    case 'ready':
      return {
        headline: `StreamDock ${version} is ready to install.`,
        detail: 'Restarting finishes the update. Downloads in progress are paused and resume afterwards.',
        tone: 'success',
      };

    case 'installing':
      return {
        headline: 'Installing the update…',
        detail: 'StreamDock will close and reopen on its own.',
        tone: 'progress',
      };

    case 'up-to-date':
      return {
        headline: `StreamDock ${version || current} is up to date.`,
        tone: 'info',
      };

    case 'unsupported':
      return {
        headline: 'Updating needs an installed copy of StreamDock.',
        detail: state.detail,
        tone: 'info',
      };

    case 'error':
      return {
        headline: state.openedFallback
          ? "Couldn't update automatically — opening the download page instead."
          : "Couldn't update automatically.",
        // The engine's own words rarely end in punctuation, and running them
        // straight into the next sentence reads as one garbled line.
        detail: [terminate(state.detail), `Download the latest version from ${UPDATE_FALLBACK_URL}`]
          .filter(Boolean)
          .join(' '),
        tone: 'error',
      };

    case 'idle':
    default:
      return { headline: '', tone: 'info' };
  }
}

/**
 * Whether this state is worth putting in front of the user.
 *
 * The launch check runs unprompted, so "you are up to date", a transient
 * "checking…", and — most importantly — a failure to reach the update server
 * are all noise from it. Someone who opened the app with no connection has not
 * asked for an update and must not be told one failed. The same states after a
 * menu click are the whole point of having clicked.
 *
 * `interactive` becomes true the moment a person presses a button in the
 * banner, so a download that a launch-time prompt started still reports its own
 * failures.
 */
export function shouldSurface(state: UpdateState): boolean {
  if (state.phase === 'idle') return false;
  if (state.interactive) return true;
  return state.phase === 'available' || state.phase === 'downloading'
    || state.phase === 'ready' || state.phase === 'installing';
}

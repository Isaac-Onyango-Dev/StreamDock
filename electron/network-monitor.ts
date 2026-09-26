// Role: notice when a running download stops receiving data, and check whether
// the internet is reachable at all.
import { net } from 'electron';

/** No progress line for this long while downloading counts as a stall. */
const STALL_MS = 30_000;
const CHECK_EVERY_MS = 5_000;

/**
 * Reports a stall; never acts on one.
 *
 * The monitor this replaces paused the download on its second stall window —
 * ten seconds after the first — while yt-dlp was still inside its own fragment
 * retries (ep 551 in the session-22 log, paused at 10.2% and never resumed,
 * because pausing disposed the monitor whose timer was meant to resume it). It
 * also told the user "Auto-resuming in 15s…" about a pause that had not
 * happened. yt-dlp's retries and the engine's offline handling decide what
 * happens to a slow download; this only says so on the row.
 *
 * It also judged stalls from speed samples that were only pruned when a new
 * one arrived, so a process that went completely silent kept its last good
 * sample forever and was never flagged. It now times the gap since the last
 * progress line.
 */
export class StallWatch {
  private lastProgressAt = Date.now();
  /** Only a download phase can stall: extraction and post-processing print no progress. */
  private downloading = false;
  private stalled = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly onChange: (stalled: boolean) => void) {
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
  }

  /** A progress line arrived. */
  progress(): void {
    this.lastProgressAt = Date.now();
    this.downloading = true;
    this.setStalled(false);
  }

  /** The run moved to a phase that prints no progress (merging, moving, tagging). */
  idle(): void {
    this.downloading = false;
    this.setStalled(false);
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  private check(): void {
    if (this.downloading && Date.now() - this.lastProgressAt >= STALL_MS) this.setStalled(true);
  }

  private setStalled(next: boolean): void {
    if (this.stalled === next) return;
    this.stalled = next;
    this.onChange(next);
  }
}

/**
 * Whether the internet is reachable, by asking a neutral host (1.1.1.1).
 *
 * Used when a download fails on a network error, to tell "the network is down"
 * (hold the queue and wait) from "that one site is down" (fail the job).
 */
export function isInternetReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 5_000);
    try {
      const req = net.request({ url: 'https://1.1.1.1', method: 'HEAD' });
      req.on('response', () => {
        clearTimeout(timeout);
        resolve(true);
      });
      req.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
      req.end();
    } catch {
      clearTimeout(timeout);
      resolve(false);
    }
  });
}

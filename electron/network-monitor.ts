// Role: per-download network condition awareness — speed rolling average, stall detection, connection classification.
import { net } from 'electron';
import log from 'electron-log';

export type StallState = 'none' | 'first' | 'second';

interface SpeedSample {
  timestamp: number;
  bytesPerSecond: number;
}

/**
 * NetworkMonitor tracks download speed, detects stalls, and classifies
 * connection loss (local network vs. site-down).
 *
 * Usage per download:
 *   const mon = new NetworkMonitor(id);
 *   mon.onStall = (state) => { ... };
 *   mon.recordSpeed(bytes);  // call whenever yt-dlp reports a progress line
 *   mon.dispose();           // call on cancel/complete
 */
export class NetworkMonitor {
  private samples: SpeedSample[] = [];
  private stall: StallState = 'none';
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  /** Rolling window in milliseconds (5 seconds). */
  private static readonly WINDOW_MS = 5_000;
  /** Stall threshold: speed = 0 for this many ms → stall. */
  private static readonly STALL_THRESHOLD_MS = 10_000;
  /** Auto-resume wait after first stall (ms). */
  private static readonly FIRST_STALL_WAIT_MS = 15_000;

  onStall: ((state: StallState) => void) | null = null;
  onAutoResume: (() => void) | null = null;

  constructor(private readonly downloadId: string) {
    // Check for stall every 2 seconds
    this.checkInterval = setInterval(() => this.checkStall(), 2_000);
  }

  /**
   * Record a speed sample parsed from yt-dlp output.
   * @param speedStr  e.g. "1.23MiB/s", "456KiB/s", "0B/s"
   */
  recordSpeedString(speedStr: string): void {
    if (this.disposed) return;
    const bps = this.parseSpeedString(speedStr);
    this.recordBytesPerSecond(bps);
  }

  recordBytesPerSecond(bps: number): void {
    if (this.disposed) return;
    const now = Date.now();
    this.samples.push({ timestamp: now, bytesPerSecond: bps });
    // Prune old samples outside rolling window
    const cutoff = now - NetworkMonitor.WINDOW_MS;
    this.samples = this.samples.filter((s) => s.timestamp >= cutoff);

    // If we got real data, clear any pending stall timer
    if (bps > 0 && this.stallTimer !== null) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
      if (this.stall !== 'none') {
        log.info(`[network-monitor] Download ${this.downloadId}: stall resolved`);
        this.stall = 'none';
      }
    }
  }

  /** Rolling average speed in bytes/sec over the last 5s window. */
  rollingAvgBps(): number {
    if (this.samples.length === 0) return 0;
    const sum = this.samples.reduce((acc, s) => acc + s.bytesPerSecond, 0);
    return sum / this.samples.length;
  }

  /** Formatted speed string for UI display. */
  formattedSpeed(): string {
    const bps = this.rollingAvgBps();
    if (bps === 0) return '';
    if (bps < 1024) return `${bps.toFixed(0)} B/s`;
    if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
    if (bps < 1024 * 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(2)} MB/s`;
    return `${(bps / (1024 * 1024 * 1024)).toFixed(2)} GB/s`;
  }

  getStallState(): StallState { return this.stall; }

  private checkStall(): void {
    if (this.disposed) return;
    const avg = this.rollingAvgBps();

    if (avg === 0 && this.samples.length > 0) {
      // All samples in window are zero → potential stall
      if (this.stallTimer === null) {
        this.stallTimer = setTimeout(() => {
          if (this.disposed) return;
          this.handleStall();
        }, NetworkMonitor.STALL_THRESHOLD_MS);
      }
    }
  }

  private handleStall(): void {
    this.stallTimer = null;
    if (this.stall === 'none') {
      this.stall = 'first';
      log.warn(`[network-monitor] Download ${this.downloadId}: first stall detected`);
      this.onStall?.('first');
      // Auto-resume after 15s
      setTimeout(() => {
        if (this.disposed || this.stall !== 'first') return;
        log.info(`[network-monitor] Download ${this.downloadId}: auto-resuming after first stall`);
        this.stall = 'none';
        this.onAutoResume?.();
      }, NetworkMonitor.FIRST_STALL_WAIT_MS);
    } else if (this.stall === 'first') {
      this.stall = 'second';
      log.warn(`[network-monitor] Download ${this.downloadId}: second stall — user must resume`);
      this.onStall?.('second');
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.checkInterval !== null) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.stallTimer !== null) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  /** Parse yt-dlp speed string to bytes/sec. */
  private parseSpeedString(s: string): number {
    if (!s) return 0;
    const match = s.match(/^([\d.]+)\s*(B|KiB|MiB|GiB|KB|MB|GB)(?:\/s)?$/i);
    if (!match) return 0;
    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    const multipliers: Record<string, number> = {
      b: 1, kb: 1000, kib: 1024,
      mb: 1_000_000, mib: 1_048_576,
      gb: 1_000_000_000, gib: 1_073_741_824,
    };
    return value * (multipliers[unit] ?? 1);
  }
}

/**
 * Classify whether a download failure is due to local network loss
 * or a remote site issue by pinging a neutral host (1.1.1.1).
 */
export async function classifyNetworkLoss(): Promise<'local' | 'remote'> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve('local'), 5_000);
    try {
      const req = net.request({ url: 'https://1.1.1.1', method: 'HEAD' });
      req.on('response', () => {
        clearTimeout(timeout);
        resolve('remote'); // We can reach internet → site issue
      });
      req.on('error', () => {
        clearTimeout(timeout);
        resolve('local'); // Can't reach internet → local network issue
      });
      req.end();
    } catch {
      clearTimeout(timeout);
      resolve('local');
    }
  });
}

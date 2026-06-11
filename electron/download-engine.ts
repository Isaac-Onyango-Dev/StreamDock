// Role: Production-grade yt-dlp process orchestration with:
//   - Full state machine (queued/running/paused/completed/failed/cancelled)
//   - Thread-safe state transitions (JS event loop + Map guard)
//   - Atomic cancel: SIGTERM → 3s timeout → SIGKILL
//   - Partial file cleanup on cancel/failure
//   - State persistence across restarts
//   - Network stall detection and auto-resume
//   - Queue management (max concurrent, FIFO priority)
//   - Structured per-download logging
//   - Zero raw stderr exposed to UI

import { app, BrowserWindow } from 'electron';
import { ChildProcess, execFile, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, rmSync, readdirSync } from 'fs';
import { basename, isAbsolute, join } from 'path';
import log from 'electron-log';
import { IPC } from './ipc-channels';
import { buildPluginDirArgs, resolveBinary, resolveYtDlpCommand, type YtDlpCommand } from './binary-resolver';
import { toUserError, isRateLimited, isAuthRequired, isGeoBlocked } from './error-translator';
import { extractManifest } from './manifest-extractor';
import { ANIME_HOSTS, MANIFEST_PROBE_HOSTS, type CaptureMode } from './url-router';
import { detectFormat, buildFormatArgs } from './format-detector';
import { NetworkMonitor, classifyNetworkLoss, type StallState } from './network-monitor';
import { StateStore } from './state-store';
import { buildOutputTemplate } from './smart-naming';

export interface DownloadRequest {
  url: string;
  mode: CaptureMode;
  outputDir: string;
  quality?: string;
  playlistItems?: string;
  audioPreference?: 'auto' | 'dub' | 'sub';
  subtitleMode?: 'none' | 'embed' | 'sidecar';
  isPlaylist?: boolean;
  /** A suggested folder name from the UI (e.g. series or playlist title) */
  folderHint?: string;
  /** Per-item title hint from the UI (e.g. "One Piece - Episode 1 - Romance Dawn").
   *  Used as the output filename for manifest-based VOD downloads where yt-dlp
   *  cannot derive a meaningful title from the CDN stream URL. */
  titleHint?: string;
  /** Whether to use browser cookies */
  useCookies?: boolean;
  /** Browser to impersonate for TLS fingerprinting */
  impersonate?: string;
  /** Additional plugin directories */
  pluginDirs?: string[];
  /** Priority in queue (lower = higher priority). Default: 100 */
  priority?: number;
  /** Optional scheduled start time (ISO string) */
  scheduledAt?: string;
  /** Thumbnail URL for display */
  thumbnail?: string;
  /** Explicit audio language code from media track probe (e.g. en, ja) */
  selectedAudioLanguage?: string;
  /** Subtitle language codes to download */
  selectedSubtitleLanguages?: string[];
  /** Convert subtitles to this format (original keeps source ext) */
  subtitleConvertFormat?: 'original' | 'srt' | 'vtt';
  /** Download subtitles without video */
  subsOnly?: boolean;
  /** User-selected packaging mode from language UI */
  downloadPackaging?: 'video-only' | 'video-audio' | 'video-subs' | 'video-audio-subs' | 'video-multi-subs' | 'subs-only';
}

export interface DownloadRecord {
  id: string;
  url: string;
  mode: CaptureMode;
  title: string;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'retrying';
  progress: number;
  speed: string;
  eta: string;
  outputPath?: string;
  error?: string;
  createdAt: string;
  priority: number;
  thumbnail?: string;
  /** Bytes downloaded (parsed from yt-dlp output) */
  bytesDownloaded: number;
  /** Total bytes (parsed from yt-dlp output) */
  bytesTotal: number;
  /** Detected format */
  detectedFormat?: string;
  /** Stall message for UI */
  stallMessage?: string;
}

interface ActiveTask {
  process: ChildProcess;
  record: DownloadRecord;
  request: DownloadRequest;
  stderr: string;
  manifestAttempted: boolean;
  monitor: NetworkMonitor;
  /** Track start time for per-download logging */
  startedAt: number;
  /** Speed samples for log on completion */
  speedSamples: string[];
  /** Temp cookies.txt written by manifest-extractor; deleted after download finishes. */
  cookiesFile?: string;
}

/** Known video CDN hosts whose manifest URLs need a specific referer. */
const KNOWN_CDNS = ['s2.cinewave2.site', 'cinewave2.site'];

const PRUNE_AGE_MS = 86_400_000; // 24 hours
type ClearRecordScope = 'all' | 'completed' | 'failed' | 'cancelled';

function extractHost(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

function matchesProbeHost(host: string): boolean {
  return MANIFEST_PROBE_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

function isIntermediatePath(filePath: string): boolean {
  const base = basename(filePath);
  return /\.f\d+\.[a-z0-9]+$/i.test(base) || /\.(vtt|srt|ass|mka|opus|3gp|dash)$/i.test(base);
}

/** Parse "1.23MiB" → bytes. */
function parseBytes(s: string): number {
  if (!s) return 0;
  const m = s.match(/^([\d.]+)\s*(B|KiB|MiB|GiB|KB|MB|GB)/i);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  const u = m[2].toLowerCase();
  const mults: Record<string, number> = {
    b: 1, kb: 1000, kib: 1024, mb: 1_000_000, mib: 1_048_576,
    gb: 1_000_000_000, gib: 1_073_741_824,
  };
  return v * (mults[u] ?? 1);
}

export class DownloadEngine {
  private tasks = new Map<string, ActiveTask>();
  private records = new Map<string, DownloadRecord>();
  private savedRequests = new Map<string, DownloadRequest>();

  /** IDs of downloads waiting to start (FIFO, sorted by priority). */
  private queue: string[] = [];

  /** Maximum concurrent active downloads. */
  private maxConcurrent = 3;

  /** Scheduler timer — fires when a scheduled download's time arrives. */
  private schedulerTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private statsUpdateInterval: NodeJS.Timeout | null = null;
  private saveStateInterval: NodeJS.Timeout | null = null;
  private lastSpawnTime = 0;

  private readonly stateStore: StateStore;

  constructor(private readonly getWindow: () => BrowserWindow | null) {
    this.stateStore = new StateStore();
    this.restoreState();
  }

  // ───────────────────────────────────────────────────────────────── Lifecycle

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, n);
    log.info(`[engine] maxConcurrent set to ${this.maxConcurrent}`);
    this.drainQueue();
  }

  getMaxConcurrent(): number { return this.maxConcurrent; }

  /** Restore persisted state on startup. */
  private restoreState(): void {
    const { records, requests } = this.stateStore.load();
    for (const r of records) {
      this.records.set(r.id, r);
    }
    for (const [id, req] of requests) {
      this.savedRequests.set(id, req);
    }
    // Re-queue anything that was "queued" at shutdown
    const queued = records
      .filter((r) => r.status === 'queued')
      .sort((a, b) => a.priority - b.priority);
    for (const r of queued) {
      if (!this.queue.includes(r.id)) this.queue.push(r.id);
    }
    log.info(`[engine] Restored ${records.length} records, queue length: ${this.queue.length}`);
  }

  private saveState(): void {
    this.stateStore.save(Array.from(this.records.values()), this.savedRequests);
  }

  // ─────────────────────────────────────────────────────────────── Public API

  list(): DownloadRecord[] {
    return Array.from(this.records.values()).sort(
      (a, b) => {
        // Active first, then by creation time
        const statusOrder = { running: 0, retrying: 1, queued: 2, paused: 3, failed: 4, completed: 5, cancelled: 6 };
        const sa = statusOrder[a.status] ?? 9;
        const sb = statusOrder[b.status] ?? 9;
        if (sa !== sb) return sa - sb;
        return Date.parse(b.createdAt) - Date.parse(a.createdAt);
      },
    );
  }

  clearRecords(scope: ClearRecordScope = 'all'): void {
    const shouldClear = (record: DownloadRecord): boolean => {
      if (scope === 'all') return ['completed', 'failed', 'cancelled'].includes(record.status);
      return record.status === scope;
    };

    for (const [id, record] of this.records) {
      if (shouldClear(record) && !this.tasks.has(id)) {
        this.records.delete(id);
        this.savedRequests.delete(id);
      }
    }
    this.pruneOldRecords();
    this.saveState();
  }

  /** Begin a new download (may queue it if concurrent limit is reached). */
  start(request: DownloadRequest): DownloadRecord {
    if (!existsSync(request.outputDir)) mkdirSync(request.outputDir, { recursive: true });

    const id = randomUUID();
    const detection = detectFormat(request.url);
    const priority = request.priority ?? 100;

    const record: DownloadRecord = {
      id,
      url: request.url,
      mode: request.mode,
      title: request.mode === 'stream' ? 'Live stream capture' : 'Video download',
      status: 'queued',
      progress: 0,
      speed: '',
      eta: '',
      createdAt: new Date().toISOString(),
      priority,
      thumbnail: request.thumbnail,
      bytesDownloaded: 0,
      bytesTotal: 0,
      detectedFormat: detection.format,
    };

    this.records.set(id, record);
    this.savedRequests.set(id, request);

    // Handle scheduling
    if (request.scheduledAt) {
      const delay = Date.parse(request.scheduledAt) - Date.now();
      if (delay > 0) {
        log.info(`[engine] Download ${id} scheduled in ${Math.round(delay / 1000)}s`);
        record.title = `Scheduled: ${record.title}`;
        this.emitProgress(record);
        const timer = setTimeout(() => {
          this.schedulerTimers.delete(id);
          this.enqueue(id, request, record);
        }, delay);
        this.schedulerTimers.set(id, timer);
        this.saveState();
        return { ...record };
      }
    }

    if (detection.isLive && detection.liveMessage) {
      log.info(`[engine] ${detection.liveMessage} for ${request.url}`);
    }

    this.enqueue(id, request, record);
    return { ...record };
  }

  private enqueue(id: string, request: DownloadRequest, record: DownloadRecord): void {
    const runningCount = this.tasks.size;
    const host = extractHost(request.url);
    const isProbeHost = matchesProbeHost(host);

    // For manifest-probe hosts (CDN-backed anime/streaming sites), limit concurrency
    // to 1 active probe-download pair at a time. This ensures each episode's CDN
    // token is minted immediately before yt-dlp uses it — no token expires while
    // waiting for another episode's long download to finish.
    // Non-probe-host downloads (YouTube, etc.) use the full maxConcurrent slots.
    const effectiveConcurrent = isProbeHost ? 1 : this.maxConcurrent;
    const probeHostActiveCount = isProbeHost
      ? Array.from(this.tasks.values()).filter((t) => matchesProbeHost(extractHost(t.request.url))).length
      : 0;
    const canSpawn = isProbeHost
      ? probeHostActiveCount < effectiveConcurrent
      : runningCount < this.maxConcurrent;

    if (canSpawn) {
      this.spawn(id, record, request);
    } else {
      record.status = 'queued';
      this.emitProgress(record);
      // Insert in priority order
      const insertAt = this.queue.findIndex((qid) => {
        const r = this.records.get(qid);
        return r && r.priority > record.priority;
      });
      if (insertAt === -1) this.queue.push(id);
      else this.queue.splice(insertAt, 0, id);
      log.info(`[engine] Download ${id} queued (position ${this.queue.indexOf(id) + 1})`);
    }
    this.saveState();
  }

  /** Start the next download in the queue if capacity allows. */
  private drainQueue(): void {
    // Process queue entries one at a time. For manifest-probe hosts, only allow
    // one active probe-download pair at a time (per the lazy-probe constraint).
    // For regular hosts, fill up to maxConcurrent.
    let i = 0;
    while (i < this.queue.length && this.tasks.size < this.maxConcurrent) {
      const nextId = this.queue[i];
      const record = this.records.get(nextId);
      const request = this.savedRequests.get(nextId);
      if (!record || !request || record.status !== 'queued') {
        this.queue.splice(i, 1);
        continue;
      }

      const host = extractHost(request.url);
      const isProbeHost = matchesProbeHost(host);
      if (isProbeHost) {
        // Only drain a probe-host item if no other probe-host download is currently active
        const probeHostActive = Array.from(this.tasks.values()).some((t) =>
          matchesProbeHost(extractHost(t.request.url)),
        );
        if (probeHostActive) {
          i++;
          continue; // Leave this item in the queue; check next item (may be a non-probe-host)
        }
      }

      this.queue.splice(i, 1);
      log.info(`[engine] Draining queue — starting download ${nextId}`);
      this.spawn(nextId, record, request);
    }
  }

  cancel(id: string): void {
    const timer = this.schedulerTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.schedulerTimers.delete(id);
    }

    // Remove from queue
    const qIdx = this.queue.indexOf(id);
    if (qIdx !== -1) this.queue.splice(qIdx, 1);

    const task = this.tasks.get(id);
    if (task) {
      task.record.status = 'cancelled';
      this.emitProgress(task.record);
      this.killProcess(task, 'cancel');
      return;
    }

    const record = this.records.get(id);
    if (record && record.status !== 'completed') {
      record.status = 'cancelled';
      this.savedRequests.delete(id);
      this.emitProgress(record);
      // Clean up any partial files for this download
      this.cleanPartialFiles(record);
      this.saveState();
    }
  }

  pause(id: string): void {
    const task = this.tasks.get(id);
    if (!task) {
      // If in queue, mark as paused
      const qIdx = this.queue.indexOf(id);
      if (qIdx !== -1) {
        this.queue.splice(qIdx, 1);
        const record = this.records.get(id);
        if (record) {
          record.status = 'paused';
          this.emitProgress(record);
          this.saveState();
        }
      }
      return;
    }
    task.record.status = 'paused';
    task.record.stallMessage = undefined;
    this.emitProgress(task.record);
    this.killProcess(task, 'pause');
    log.info(`[engine] Download ${id} paused at ${task.record.progress.toFixed(1)}%`);
  }

  resume(id: string): void {
    const request = this.savedRequests.get(id);
    const record = this.records.get(id);
    if (!request || !record) return;
    if (this.tasks.has(id)) return; // Already running

    if (this.tasks.size >= this.maxConcurrent) {
      // Re-enqueue with priority
      record.status = 'queued';
      this.emitProgress(record);
      if (!this.queue.includes(id)) {
        const insertAt = this.queue.findIndex((qid) => {
          const r = this.records.get(qid);
          return r && r.priority > record.priority;
        });
        if (insertAt === -1) this.queue.push(id);
        else this.queue.splice(insertAt, 0, id);
      }
      return;
    }

    record.error = undefined;
    record.stallMessage = undefined;
    this.spawn(id, record, request);
  }

  retry(id: string): void {
    const request = this.savedRequests.get(id);
    const record = this.records.get(id);
    if (!request || !record) return;
    if (this.tasks.has(id)) return;

    record.error = undefined;
    record.stallMessage = undefined;
    record.progress = 0;
    record.speed = '';
    record.eta = '';
    record.bytesDownloaded = 0;
    record.status = 'retrying';
    this.emitProgress(record);

    log.info(`[engine] Retrying download ${id}`);

    if (this.tasks.size >= this.maxConcurrent) {
      record.status = 'queued';
      this.emitProgress(record);
      if (!this.queue.includes(id)) this.queue.unshift(id); // High priority
      return;
    }

    this.spawn(id, record, request);
  }

  /** Pause all active downloads atomically. */
  stopAll(mode: 'pause' | 'cancel' = 'pause'): void {
    log.info(`[engine] stopAll (${mode}): ${this.tasks.size} active, ${this.queue.length} queued`);
    const ids = [...this.tasks.keys(), ...this.queue];
    for (const id of ids) {
      if (mode === 'pause') this.pause(id);
      else this.cancel(id);
    }
  }

  resumeAll(): void {
    const pausedIds = Array.from(this.records.values())
      .filter((r) => r.status === 'paused')
      .map((r) => r.id);
    for (const id of pausedIds) this.resume(id);
  }

  /** Reorder queue: move id to position (0-based). */
  reorder(id: string, newPosition: number): void {
    const idx = this.queue.indexOf(id);
    if (idx === -1) return;
    this.queue.splice(idx, 1);
    const pos = Math.max(0, Math.min(newPosition, this.queue.length));
    this.queue.splice(pos, 0, id);
    // Update priority field
    this.queue.forEach((qid, i) => {
      const r = this.records.get(qid);
      if (r) r.priority = (i + 1) * 10;
    });
    log.info(`[engine] Reordered ${id} to position ${pos}`);
    this.saveState();
  }

  activeCount(): number { return this.tasks.size; }
  queueLength(): number { return this.queue.length; }

  // ─────────────────────────────────────────────── Process Management (GOAL 8)

  /**
   * Kill a process safely, terminating the FULL process tree.
   *
   * On Windows, Node's `proc.kill('SIGTERM')` only terminates the yt-dlp
   * parent. Any sub-processes it spawned (ffmpeg, aria2c) are orphaned and
   * keep running — this is why Pause/Cancel appeared to work in the UI while
   * the download continued on disk.
   *
   * Fix: on Windows use `taskkill /pid <PID> /T /F` which recursively
   * terminates every process in the tree. On Mac/Linux SIGTERM → SIGKILL
   * already propagates correctly.
   */
  private killProcess(task: ActiveTask, reason: string): void {
    const { process: proc, record, monitor } = task;
    monitor.dispose();

    if (!proc || proc.killed || proc.exitCode !== null) return;

    const pid = proc.pid;
    log.debug(`[engine] Killing process tree for ${record.id} (reason=${reason}, pid=${pid})`);

    if (process.platform === 'win32' && pid !== undefined) {
      // Atomically kill the yt-dlp parent AND all its children (ffmpeg, aria2c, etc.)
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], (err) => {
        if (err) {
          // taskkill failed (process may have already exited) — fall back to Node kill
          log.warn(`[engine] taskkill failed for pid ${pid}: ${err.message}. Falling back to proc.kill().`);
          try { proc.kill(); } catch { /* already dead */ }
        } else {
          log.debug(`[engine] taskkill /T /F succeeded for pid ${pid}`);
        }
      });
    } else {
      // Mac / Linux: SIGTERM then SIGKILL after 3 s
      proc.kill('SIGTERM');

      const killTimer = setTimeout(() => {
        if (!proc.killed && proc.exitCode === null) {
          log.warn(`[engine] Process for ${record.id} did not exit after SIGTERM, sending SIGKILL`);
          try { proc.kill('SIGKILL'); } catch { /* already dead */ }
        }
      }, 3_000);

      proc.once('exit', () => clearTimeout(killTimer));
    }
  }

  /** Delete partial/temp files for a download. */
  private cleanPartialFiles(record: DownloadRecord): void {
    if (!record.outputPath) return;
    try {
      // Clean the actual output path if it's not completed
      if (record.status !== 'completed' && existsSync(record.outputPath)) {
        rmSync(record.outputPath, { force: true });
        log.debug(`[engine] Cleaned partial file: ${basename(record.outputPath)}`);
      }
      // Clean .part files in the same directory
      const dir = record.outputPath.substring(0, record.outputPath.lastIndexOf('/') || record.outputPath.lastIndexOf('\\'));
      if (existsSync(dir)) {
        readdirSync(dir)
          .filter((f) => f.endsWith('.part') || f.endsWith('.ytdl'))
          .forEach((f) => {
            try { rmSync(join(dir, f), { force: true }); } catch { /* ignore */ }
          });
      }
    } catch (err) {
      log.debug(`[engine] Could not clean partial files:`, err);
    }
  }

  // ──────────────────────────────────────────────────────────── Spawn & Wire

  private spawn(id: string, record: DownloadRecord, request: DownloadRequest): void {
    record.status = 'running';
    record.speed = '';
    record.eta = '';
    record.stallMessage = undefined;
    this.emitProgress(record);

    const monitor = new NetworkMonitor(id);
    this.wireMonitor(id, monitor);

    const task: ActiveTask = {
      process: null as any, // Set later after extraction
      record,
      request,
      stderr: '',
      manifestAttempted: false,
      monitor,
      startedAt: Date.now(),
      speedSamples: [],
    };

    this.tasks.set(id, task);
    this.records.set(id, record);
    this.saveState();

    this.runExtractionAndSpawn(id, task, request).catch((err) => this.fail(id, err));
  }

  private async runExtractionAndSpawn(id: string, task: ActiveTask, request: DownloadRequest): Promise<void> {
    const host = extractHost(request.url);
    const { record } = task;
    let spawnUrl = request.url;
    const originalPageUrl = request.url;
    let referer: string | undefined;

    if (matchesProbeHost(host)) {
      record.title = 'Extracting stream manifest…';
      this.emitProgress(record);

      log.info(`[engine] Attempting manifest extraction BEFORE yt-dlp for ${request.url}`);
      try {
        const result = await extractManifest(request.url);
        if (record.status === 'cancelled' || record.status === 'paused') return;

        if (result && result.manifestUrl) {
          log.info(`[engine] Manifest extraction successful: ${result.manifestUrl}`);
          spawnUrl = result.manifestUrl;
          referer = result.referer;
          
          // Only force 'stream' naming if the original request was actually a stream.
          // VODs (like anime episodes) should stay as 'video' so they don't get 
          // named "StreamDock Stream...".
          const isActuallyStream = request.mode === 'stream';
          request = { ...request, url: spawnUrl };
          task.request = request;
          task.manifestAttempted = true;
          task.cookiesFile = result.cookiesFile;
          
          if (isActuallyStream) {
            record.title = 'Live stream capture';
          }
        } else {
          log.info(`[engine] Manifest extraction returned nothing, falling back to original URL.`);
        }
      } catch (err) {
        log.warn(`[engine] Manifest extraction failed:`, err);
      }
    }

    if (record.status === 'cancelled' || record.status === 'paused') return;

    // Bug 2 fix: for manifest-fallback VODs, use the per-item titleHint passed from
    // the UI (e.g. "One Piece - Episode 1 - Romance Dawn"). This is more reliable than
    // record.title which at this point holds a display-only status string like
    // 'Extracting stream manifest...'. If no titleHint was provided, fall back to
    // record.title only if it looks like a real title (not a status message).
    const isManifestFallback = task.manifestAttempted && request.mode === 'video';
    const statusStrings = new Set(['Extracting stream manifest\u2026', 'Live stream capture', 'Video download']);
    const episodeTitle = isManifestFallback
      ? (request.titleHint || (!statusStrings.has(record.title) ? record.title : undefined))
      : undefined;

    record.title = request.mode === 'stream' ? 'Live stream capture' : 'Video download';
    this.emitProgress(record);

    const ffmpeg = resolveBinary('ffmpeg');
    const ytDlpCmd = this.resolveYtDlpCmd(spawnUrl);

    // Use the captured episode title (not record.title which is now 'Video download').
    const forcedTitle = episodeTitle;
    
    const args = this.buildArgs(request, ffmpeg, originalPageUrl, referer, forcedTitle);

    // Inject --cookies before the -- URL separator if the manifest extractor
    // captured session cookies from the embed CDN response.
    if (task.cookiesFile && existsSync(task.cookiesFile)) {
      const sepIdx = args.indexOf('--');
      if (sepIdx !== -1) args.splice(sepIdx, 0, '--cookies', task.cookiesFile);
      else args.push('--cookies', task.cookiesFile);
      log.info(`[engine] Passing cookies file to yt-dlp: ${task.cookiesFile}`);
    }

    const fullCmd = [ytDlpCmd.command, ...ytDlpCmd.args, ...args].join(' ');
    log.info(`[engine] Spawning download ${id} | format=${record.detectedFormat} | cmd=${fullCmd.substring(0, 400)}`);

    // Stagger spawn times by at least 3000ms to prevent SQLite locking
    // when multiple instances attempt to extract cookies simultaneously.
    const now = Date.now();
    const timeSinceLastSpawn = now - this.lastSpawnTime;
    if (timeSinceLastSpawn < 3000) {
      const waitTime = 3000 - timeSinceLastSpawn;
      log.info(`[engine] Staggering spawn for ${id} by ${waitTime}ms to prevent cookie DB locking...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    this.lastSpawnTime = Date.now();

    const child = spawn(ytDlpCmd.command, [...ytDlpCmd.args, ...args], {
      windowsHide: true,
      // stdio: pipe to capture all output without buffering to RAM
    });

    task.process = child;
    task.startedAt = Date.now();

    child.stdout?.on('data', (chunk: Buffer) => this.consume(id, chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => {
      const t = this.tasks.get(id);
      const text = chunk.toString();
      if (t) {
        t.stderr += text;
        if (t.stderr.length > 65_536) t.stderr = t.stderr.slice(-65_536);
      }
      this.consume(id, text);
    });
    child.on('error', (error) => this.fail(id, error));
    child.on('close', (code) => this.close(id, code, child));
  }

  private wireMonitor(id: string, monitor: NetworkMonitor): void {
    monitor.onStall = async (state: StallState) => {
      const task = this.tasks.get(id);
      if (!task) return;

      if (state === 'first') {
        log.warn(`[engine] Download ${id}: first stall, auto-pausing`);
        // Classify: local vs remote
        const lossType = await classifyNetworkLoss();
        if (lossType === 'local') {
          task.record.stallMessage = 'No internet connection. Will retry automatically.';
        } else {
          task.record.stallMessage = 'Download stalled. Auto-resuming in 15s…';
        }
        this.emitProgress(task.record);
      } else if (state === 'second') {
        log.warn(`[engine] Download ${id}: second stall, pausing for user`);
        task.record.stallMessage = 'Slow or no connection. Resume when ready.';
        this.emitProgress(task.record);
        this.pause(id);
      }
    };

    monitor.onAutoResume = () => {
      const record = this.records.get(id);
      if (record && record.status === 'running') {
        // Still running — stall resolved naturally
        record.stallMessage = undefined;
        this.emitProgress(record);
      } else if (record && record.status === 'paused') {
        // Was paused during stall — resume
        this.resume(id);
      }
    };
  }

  // ──────────────────────────────────────────────────────────── Output Parsing

  private consume(id: string, chunk: string): void {
    const task = this.tasks.get(id);
    if (!task) return;

    for (const line of chunk.split(/[\r\n]+/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      log.debug(`[engine:${id}] ${trimmed.substring(0, 200)}`);

      // Final merged file destination
      const merger = trimmed.match(/\[Merger\]\s+Merging formats into\s+"(.+)"/i);
      if (merger) {
        task.record.outputPath = merger[1].trim();
        task.record.title = basename(task.record.outputPath).replace(/\.[^.]+$/, '');
        this.emitProgress(task.record);
        continue;
      }

      // Destination line (non-intermediate only)
      const dest = trimmed.match(/\[download\]\s+Destination:\s+(.+)$/i);
      if (dest) {
        const newPath = dest[1].trim();
        task.record.outputPath = newPath;
        if (!isIntermediatePath(newPath)) {
          task.record.title = basename(newPath).replace(/\.[^.]+$/, '');
          this.emitProgress(task.record);
        }
        continue;
      }

      // Progress: "[download]  42.5% of   234.56MiB at    1.23MiB/s ETA 00:45"
      const progress = trimmed.match(
        /\[download\]\s+([\d.]+)%(?:\s+of\s+([\d.]+\s*(?:B|KiB|MiB|GiB)))?(?:.*?at\s+([^\s]+(?:\/s)?))?(?:.*?ETA\s+([^\s]+))?/i,
      );
      if (progress) {
        const pct = parseFloat(progress[1]) || 0;
        task.record.progress = Math.min(pct, 99.9);

        if (progress[2]) {
          task.record.bytesTotal = parseBytes(progress[2]);
          task.record.bytesDownloaded = Math.round((pct / 100) * task.record.bytesTotal);
        }

        if (progress[3]) {
          task.record.speed = progress[3];
          task.monitor.recordSpeedString(progress[3]);
          task.speedSamples.push(progress[3]);
          if (task.speedSamples.length > 100) task.speedSamples.shift();
        }

        if (progress[4]) task.record.eta = progress[4];
        this.emitProgress(task.record);
        continue;
      }

      // Thumbnail extraction
      const thumb = trimmed.match(/thumbnail[:\s]+(.+\.(jpg|jpeg|png|webp))/i);
      if (thumb) {
        task.record.thumbnail = thumb[1].trim();
      }

      // Error lines — classify and emit
      if (/error:/i.test(trimmed) || trimmed.startsWith('ERROR')) {
        const userMsg = this.classifyErrorLine(trimmed, task);
        if (userMsg) {
          task.record.error = userMsg;
          this.emitError(task.record);
        }
      }
    }
  }

  /** Classify a single yt-dlp error line into a user-facing message. */
  private classifyErrorLine(line: string, task: ActiveTask): string | null {
    if (isRateLimited(line)) {
      log.warn(`[engine] Rate limited for ${task.record.id}`);
      return 'Rate limited. Waiting before retrying…';
    }

    // A 403 on a CDN manifest URL is a session/token problem, not a login wall.
    // Guard: skip the auth check when we have already resolved a manifest URL
    // (manifestAttempted=true) or when the error line mentions a known CDN domain.
    const isCdnContext =
      task.manifestAttempted ||
      /cdn\.|mewstream|nekostream|megaplay\.buzz|cinewave|gogocdn/i.test(line);

    if (isAuthRequired(line) && !isCdnContext) {
      log.warn(`[engine] Auth required for ${task.record.id}`);
      return 'This content requires a login. Please log in on the site first.';
    }
    if (isGeoBlocked(line)) {
      log.warn(`[engine] Geo-blocked for ${task.record.id}`);
      return 'This content may not be available in your region.';
    }
    if (isCdnContext && isAuthRequired(line)) {
      log.warn(`[engine] CDN access denied for ${task.record.id} — likely a session/token expiry`);
      return 'Could not access the video stream. The link may have expired — try again.';
    }
    return toUserError(line);
  }

  // ──────────────────────────────────────────────────────────── Process Events

  private close(id: string, code: number | null, process: ChildProcess): void {
    const task = this.tasks.get(id);
    if (!task) return;
    if (task.process !== process) return; // Stale event from killed process

    task.monitor.dispose();
    this.tasks.delete(id);

    // Clean up any temp cookies file written by the manifest extractor.
    if (task.cookiesFile) {
      try { rmSync(task.cookiesFile, { force: true }); } catch { /* non-fatal */ }
    }

    const elapsed = ((Date.now() - task.startedAt) / 1000).toFixed(1);
    log.info(
      `[engine] Download ${id} closed | code=${code} | elapsed=${elapsed}s | ` +
      `bytes=${task.record.bytesDownloaded} | format=${task.record.detectedFormat}`,
    );

    // Drain queue — capacity freed
    this.drainQueue();
    this.pruneOldRecords();

    if (task.record.status === 'cancelled' || task.record.status === 'paused') {
      // Clean partial files on cancel, keep them on pause (for resume)
      if (task.record.status === 'cancelled') {
        this.cleanPartialFiles(task.record);
        this.savedRequests.delete(id);
      }
      this.emitProgress(task.record);
      this.saveState();
      return;
    }

    if (code === 0) {
      task.record.status = 'completed';
      task.record.progress = 100;
      task.record.speed = '';
      task.record.eta = '';
      task.record.stallMessage = undefined;
      this.emitProgress(task.record);
      this.getWindow()?.webContents.send(IPC.EVENT_DOWNLOAD_COMPLETE, { ...task.record });
      log.info(`[engine] Download ${id} completed: ${task.record.title}`);
      this.saveState();
      return;
    }

    // Non-zero exit — decide whether to retry with manifest extraction
    if (!task.manifestAttempted) {
      const stderrLower = (task.stderr || '').toLowerCase();
      const host = extractHost(task.request.url);
      const isManifestHost = matchesProbeHost(host);

      const shouldRetry =
        isManifestHost && (
          stderrLower.includes('unsupported url') ||
          stderrLower.includes('no video formats found') ||
          stderrLower.includes('timed out') ||
          stderrLower.includes('http error') ||
          stderrLower.match(/\b4\d{2}\b/) !== null ||
          stderrLower.match(/\b5\d{2}\b/) !== null ||
          stderrLower.includes('connection') ||
          stderrLower.includes('unable to extract')
        );

      if (shouldRetry) {
        this.retryWithManifest(id, task);
        return;
      }
    }

    this.fail(id, new Error(task.stderr || `yt-dlp exited with code ${code ?? 'unknown'}`), task.record);
  }

  private retryWithManifest(id: string, failedTask: ActiveTask): void {
    const { record, request } = failedTask;
    record.title = 'Extracting stream manifest…';
    record.progress = 0;
    record.speed = '';
    record.eta = '';
    this.emitProgress(record);

    log.info(`[engine] Attempting manifest extraction for ${request.url}`);

    extractManifest(request.url)
      .then(async (result) => {
        if (record.status === 'cancelled') return;

        if (!result) {
          log.warn('[engine] No manifest found, failing download');
          this.fail(id, new Error('Could not find a playable stream on this page. Try pasting the direct manifest URL.'), record);
          return;
        }

        log.info(`[engine] Retrying with manifest: ${result.manifestUrl}`);

        const retryRequest: DownloadRequest = {
          ...request,
          url: result.manifestUrl,
          mode: 'stream',
          impersonate: request.impersonate || 'chrome',
        };

        const ffmpeg = resolveBinary('ffmpeg');
        const ytDlpCmd = this.resolveYtDlpCmd(retryRequest.url);
        
        const isManifestFallback = retryRequest.mode === 'video';
        const forcedTitle = isManifestFallback ? record.title : undefined;
        
        // Pass the original page URL for impersonation host check (not the CDN manifest URL)
        const args = this.buildArgs(retryRequest, ffmpeg, request.url, result.referer, forcedTitle);

        // Propagate any session cookies from the manifest extractor.
        if (result.cookiesFile && existsSync(result.cookiesFile)) {
          const sepIdx = args.indexOf('--');
          if (sepIdx !== -1) args.splice(sepIdx, 0, '--cookies', result.cookiesFile);
          else args.push('--cookies', result.cookiesFile);
          log.info(`[engine] Passing cookies file to yt-dlp (retry): ${result.cookiesFile}`);
        }

        const fullCmd = [ytDlpCmd.command, ...ytDlpCmd.args, ...args].join(' ');
        log.info(`[engine] Retry spawn ${id} | cmd=${fullCmd.substring(0, 400)}`);
        
        const now = Date.now();
        const timeSinceLastSpawn = now - this.lastSpawnTime;
        if (timeSinceLastSpawn < 3000) {
          await new Promise(resolve => setTimeout(resolve, 3000 - timeSinceLastSpawn));
        }
        this.lastSpawnTime = Date.now();
        
        const child = spawn(ytDlpCmd.command, [...ytDlpCmd.args, ...args], { windowsHide: true });

        record.status = 'running';
        if (retryRequest.mode === 'stream') {
          record.title = 'Live stream capture';
        }
        const monitor = new NetworkMonitor(id);
        this.wireMonitor(id, monitor);

        const newTask: ActiveTask = {
          process: child,
          record,
          request: retryRequest,
          stderr: '',
          manifestAttempted: true,
          monitor,
          startedAt: Date.now(),
          speedSamples: [],
          cookiesFile: result.cookiesFile, // tracked for cleanup in close()
        };

        this.tasks.set(id, newTask);
        this.records.set(id, record);
        this.emitProgress(record);

        child.stdout?.on('data', (chunk: Buffer) => this.consume(id, chunk.toString()));
        child.stderr?.on('data', (chunk: Buffer) => {
          const t = this.tasks.get(id);
          if (t) t.stderr += chunk.toString();
          this.consume(id, chunk.toString());
        });
        child.on('error', (error) => this.fail(id, error));
        child.on('close', (retryCode) => this.close(id, retryCode, child));
      })
      .catch((err) => {
        log.error('[engine] Manifest extraction error:', err);
        this.fail(id, err, record);
      });
  }

  private fail(id: string, error: unknown, knownRecord?: DownloadRecord): void {
    const task = this.tasks.get(id);
    const record = knownRecord ?? task?.record;
    if (task) {
      task.monitor.dispose();
      this.tasks.delete(id);
    }
    if (!record) return;

    if (record.status === 'cancelled' || record.status === 'paused') return;

    const userMsg = toUserError(error);
    log.error(`[engine] Download ${id} failed: ${userMsg}`);

    // Preserve the request for retry
    if (task) this.savedRequests.set(id, task.request);

    record.status = 'failed';
    record.error = userMsg;
    this.emitProgress(record);
    this.emitError(record);
    this.drainQueue();
    this.saveState();
  }

  // ──────────────────────────────────────────────── Argument Construction

  private resolveYtDlpCmd(url: string): YtDlpCommand {
    const host = extractHost(url);
    const isAnime = ANIME_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
    if (isAnime) {
      // Anime sites use .py plugin extractors (anikoto.py, aniwatch.py, etc.).
      // These ONLY work when running yt-dlp as a Python module (python -m yt_dlp),
      // NOT with the native binary. Prefer Python so the plugins are actually loaded.
      try { return resolveYtDlpCommand(true); } catch { /* fall through */ }
    }
    const path = resolveBinary('yt-dlp');
    return { command: path, args: [], type: 'native' };
  }

  private resolveFinalUrl(url: string): string {
    const host = extractHost(url);
    if (host === 'open.spotify.com' || host === 'spotify.com') {
      return `ytsearch1:${url}`;
    }
    return url;
  }

  private buildPluginDirArgs(userDirs?: string[]): string[] {
    return buildPluginDirArgs(userDirs);
  }

  private buildArgs(
    request: DownloadRequest, 
    ffmpeg: string, 
    originalPageUrl?: string, 
    referer?: string,
    forcedTitle?: string
  ): string[] {
    const finalUrl = this.resolveFinalUrl(request.url);
    const detection = detectFormat(request.url);

    const args: string[] = [
      '--newline',
      '--progress',
      '--no-colors',
      '--windows-filenames',
      '--trim-filenames', '180',
      '--ffmpeg-location', ffmpeg,
      '--retries', '3',
      '--fragment-retries', '3',
      '--retry-sleep', 'fragment:exp=1:10',
      // Rate limiting: be polite
      '--sleep-requests', '0.5',
      ...(this.buildImpersonationArgs(request, originalPageUrl, referer)),
      ...this.buildPluginDirArgs(request.pluginDirs),
      '-o', this.resolveOutputPath(request, forcedTitle),
      // yt-dlp writes to a .part file and renames on success by default (atomicity).
      // '--write-thumbnail' is intentionally omitted: passing it without '--embed-thumbnail'
      // causes yt-dlp to leave a loose .webp/.jpg file next to the merged .mp4 (Bug 1 fix).
    ];

    // NOTE: --cookies-from-browser chrome is intentionally omitted.
    // On Windows, Chrome holds a lock on the SQLite cookie database via the
    // Restart Manager (RmShutdown error 351), causing yt-dlp to crash every
    // time Chrome is open. The useCookies flag is preserved for future use
    // (e.g. exported cookies.txt), but browser-direct extraction is disabled.

    // Add format-specific args from detector
    const formatArgs = buildFormatArgs(detection, request.quality);
    args.push(...formatArgs);

    // Override mode-specific args if not using detector
    if (request.mode === 'video' && detection.format === 'unknown') {
      if (request.playlistItems) {
        args.push('--yes-playlist', '--playlist-items', request.playlistItems);
      } else if (request.isPlaylist) {
        args.push('--yes-playlist');
      } else {
        args.push('--no-playlist');
      }
      if (!request.quality) {
        // Replace any -f already added by buildFormatArgs
        const fIdx = args.lastIndexOf('-f');
        if (fIdx !== -1) {
          args[fIdx + 1] = 'bestvideo+bestaudio/best';
        }
        if (!args.includes('--merge-output-format')) {
          args.push('--merge-output-format', 'mp4');
        }
      }
    }

    this.applyLanguageAndSubtitleArgs(args, request);

    // For known CDN hosts: only fall back to the hardcoded referer if the
    // manifest extractor didn't already supply a more accurate one (via the
    // referer parameter captured from the browser's Referer header).
    if (!referer) {
      for (const cdn of KNOWN_CDNS) {
        if (request.url.includes(cdn)) {
          args.push('--referer', 'https://megaplay.buzz/');
          break;
        }
      }
    }

    args.push('--', finalUrl);
    return args;
  }

  private applyLanguageAndSubtitleArgs(args: string[], request: DownloadRequest): void {
    const packaging = request.downloadPackaging;
    const wantsSubs =
      packaging === 'video-subs' ||
      packaging === 'video-audio-subs' ||
      packaging === 'video-multi-subs' ||
      packaging === 'subs-only' ||
      (request.selectedSubtitleLanguages && request.selectedSubtitleLanguages.length > 0) ||
      (request.subtitleMode && request.subtitleMode !== 'none');

    if (request.subsOnly || packaging === 'subs-only') {
      args.push('--skip-download', '--write-subs', '--write-auto-subs');
    }

    if (request.selectedAudioLanguage) {
      const lang = request.selectedAudioLanguage;
      const formatIdx = args.lastIndexOf('-f');
      if (formatIdx !== -1) {
        args[formatIdx + 1] = `bestvideo+bestaudio[language=${lang}]/bestvideo+bestaudio/best`;
      } else {
        args.push('-f', `bestvideo+bestaudio[language=${lang}]/bestvideo+bestaudio/best`);
      }
      args.push('--format-sort', `lang:${lang}:res,fps`);
    } else if (request.audioPreference === 'dub') {
      args.push('--format-sort', 'lang:en,quality,res,fps');
      args.push('--audio-multistreams');
    } else if (request.audioPreference === 'sub') {
      args.push('--format-sort', 'lang:ja,lang:original,quality,res,fps');
      args.push('--audio-multistreams');
    } else if (packaging === 'video-audio' || packaging === 'video-audio-subs') {
      args.push('--audio-multistreams');
    }

    if (wantsSubs) {
      const langs = request.selectedSubtitleLanguages?.length
        ? request.selectedSubtitleLanguages.join(',')
        : 'en.*,en';
      if (!args.includes('--write-subs')) args.push('--write-subs');
      if (!args.includes('--write-auto-subs')) args.push('--write-auto-subs');
      args.push('--sub-langs', langs);
      if (request.subtitleMode === 'embed') args.push('--embed-subs');
      if (request.subtitleConvertFormat === 'srt') args.push('--convert-subs', 'srt');
      if (request.subtitleConvertFormat === 'vtt') args.push('--convert-subs', 'vtt');
    }

  }

  private resolveOutputPath(request: DownloadRequest, forcedTitle?: string): string {
    const template = buildOutputTemplate({ ...request, forcedTitle });
    return isAbsolute(template) ? template : join(request.outputDir, template);
  }

  private buildImpersonationArgs(request: DownloadRequest, originalUrl?: string, referer?: string): string[] {
    const checkUrl = originalUrl || request.url;
    const host = extractHost(checkUrl);
    const shouldImpersonate = Boolean(request.impersonate) || matchesProbeHost(host);
    if (!shouldImpersonate) return [];

    const browser = request.impersonate || 'chrome';
    const args = [
      '--impersonate', browser,
      '--extractor-args', `generic:impersonate=${browser}`,
    ];

    if (referer) {
      args.push('--referer', referer);
    } else if (originalUrl && originalUrl !== request.url) {
      args.push('--referer', originalUrl);
    }

    return args;
  }

  // ──────────────────────────────────────────────────────── IPC Emit

  private emitProgress(record: DownloadRecord): void {
    this.records.set(record.id, record);
    this.getWindow()?.webContents.send(IPC.EVENT_DOWNLOAD_PROGRESS, { ...record });
  }

  private emitError(record: DownloadRecord): void {
    this.getWindow()?.webContents.send(IPC.EVENT_DOWNLOAD_ERROR, { ...record });
  }

  // ──────────────────────────────────────────────────────── Maintenance

  private pruneOldRecords(): void {
    const cutoff = Date.now() - PRUNE_AGE_MS;
    for (const [id, record] of this.records) {
      if (['completed', 'failed', 'cancelled'].includes(record.status)) {
        if (new Date(record.createdAt).getTime() < cutoff) {
          this.records.delete(id);
          this.savedRequests.delete(id);
        }
      }
    }
  }

  /** Called on app quit — kill all processes cleanly. */
  shutdown(): void {
    log.info(`[engine] Shutdown: pausing ${this.tasks.size} active downloads`);

    // Pause all active (saves state so they resume on next start)
    for (const [id] of this.tasks) {
      this.pause(id);
    }

    // Cancel scheduler timers
    for (const [, timer] of this.schedulerTimers) {
      clearTimeout(timer);
    }
    this.schedulerTimers.clear();

    // Final state save
    this.saveState();
  }
}

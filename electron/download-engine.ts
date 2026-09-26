// Role: yt-dlp process orchestration — the download queue and its lifecycle.
//
// One owner per decision, because every lifecycle bug found in session 22 came
// from two places answering the same question:
//
//   transition()      the only place a download's status changes; it refuses
//                     moves the lifecycle does not allow and clears what the
//                     new state must not carry (an error on a completed row)
//   pump()            the only place a download starts, via planStarts() —
//                     global limit, per-host limit, start spacing, offline
//   startRun()        the only pipeline: resolve a manifest if the host needs
//                     one, then spawn yt-dlp. Abortable in either phase.
//   close()           the only reader of a process exit; settleFailure()
//                     decides between "wait for the network" and "failed"
//
// Status used to be assigned from twelve methods and admission implemented four
// times (enqueue, drainQueue, resume, retry — each with a different rule), which
// is how a resolved anime job stopped counting against its own host, a paused
// one kept its slot forever, and a completed one kept an error.

import type { BrowserWindow } from 'electron';
import { ChildProcess, execFile, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, rmSync, readdirSync } from 'fs';
import { basename, dirname, join } from 'path';
import log from 'electron-log';
import { IPC } from './ipc-channels';
import { buildPluginDirArgs, resolveBinary } from './binary-resolver';
import { toErrorDetail, classifyEngineFailure, isNetworkFailure } from './error-translator';
import { extractManifest, type ManifestResult } from './manifest-extractor';
import { CONCURRENCY, MANIFEST_PROBE_HOSTS, REFERENCE_HOSTS } from './url-router';
import { detectFormat, buildFormatArgs } from './format-detector';
import { StallWatch, isInternetReachable } from './network-monitor';
import { StateStore } from './state-store';
import { buildOutputTemplate } from './smart-naming';
import { buildSubtitleArgs } from '../shared/subtitle-args';
import type { DownloadRecord, DownloadRequest, DownloadStatus } from '../shared/downloads';

export type { DownloadRecord, DownloadRequest, DownloadStatus } from '../shared/downloads';
import { persistence } from './persistence';
import { describeWait, planStarts, type HostPolicy } from './scheduler';

/** The moves the lifecycle allows. Anything else is a bug, logged and refused. */
const NEXT: Record<DownloadStatus, readonly DownloadStatus[]> = {
  scheduled: ['queued', 'paused', 'cancelled'],
  queued: ['resolving', 'running', 'paused', 'cancelled'],
  // → queued: held for the network rather than failed (settleFailure).
  resolving: ['running', 'queued', 'paused', 'cancelled', 'failed'],
  running: ['completed', 'queued', 'paused', 'cancelled', 'failed'],
  paused: ['queued', 'cancelled'],
  failed: ['queued', 'cancelled'],
  completed: [],
  cancelled: [],
};

const TERMINAL_STATUSES = new Set<DownloadStatus>(['completed', 'failed', 'cancelled']);

/** One attempt at a download: its extraction, its process, and nothing else. */
interface ActiveTask {
  /** null until yt-dlp is spawned; always null during resolving. */
  process: ChildProcess | null;
  record: DownloadRecord;
  /** The request as queued. Never rewritten — the resolved URL is `spawnUrl`. */
  request: DownloadRequest;
  /** The host the scheduler counts this attempt against: the page, never a CDN. */
  host: string;
  /** What yt-dlp is actually given: the page, or the manifest resolved from it. */
  spawnUrl: string;
  stderr: string;
  manifestAttempted: boolean;
  watch: StallWatch;
  /** Cancels a pending extraction when the attempt is paused or cancelled. */
  abort: AbortController;
  startedAt: number;
  /** Temp cookies.txt written by manifest-extractor; deleted when the attempt ends. */
  cookiesFile?: string;
  /**
   * Files this attempt moved out of staging into the download folder.
   *
   * A move is not proof of a good file: with fragments skipped yt-dlp moved a
   * 59MB "episode" into the folder and *then* exited 1 (ep 553 in the
   * session-22 log). Kept so a failed single-item run can take back what it
   * delivered — otherwise `--no-overwrites` makes the retry report the
   * truncated file as "Already saved".
   */
  movedFiles: string[];
  /** Set once the attempt's outcome has been decided; an exit and an 'error' event can both arrive. */
  settled: boolean;
}

/** Known video CDN hosts whose manifest URLs need a specific referer. */
const KNOWN_CDNS = ['s2.cinewave2.site', 'cinewave2.site'];

/** Folder inside the download directory where in-progress files are staged. */
const STAGING_DIR_NAME = '.streamdock-incomplete';

/**
 * Longest the engine will wait for one extraction attempt before giving up on
 * it. Generous: the extractor retries internally.
 */
const MANIFEST_EXTRACTION_CEILING_MS = 120_000;

/** Extraction attempts per download before falling back (or failing on language). */
const EXTRACTION_ATTEMPTS = 2;

/** A network failure while offline puts the job back in the queue at most this often. */
const MAX_NETWORK_RETRIES = 3;
const OFFLINE_RECHECK_MS = 10_000;
const SAVE_DEBOUNCE_MS = 500;
/**
 * Least time between two progress events for one download. yt-dlp prints a
 * progress line per fragment, and every one used to become an IPC message, a
 * full re-render of the renderer, and an IPC back to main for the tray
 * tooltip. Status changes are never delayed.
 */
const PROGRESS_INTERVAL_MS = 250;

const STALL_MESSAGE = 'No data for 30 seconds — the connection may have dropped. yt-dlp is retrying.';

function extractHost(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

function matchesProbeHost(host: string): boolean {
  return MANIFEST_PROBE_HOSTS().some((d) => host === d || host.endsWith(`.${d}`));
}

function isIntermediatePath(filePath: string): boolean {
  const base = basename(filePath);
  return /\.f\d+\.[a-z0-9]+$/i.test(base) || /\.(vtt|srt|ass|mka|opus|3gp|dash)$/i.test(base);
}

/** yt-dlp phases that print no progress, so silence during them is not a stall. */
const POSTPROCESS_LINE = /^\[(Merger|Fixup\w*|Metadata|MoveFiles|Embed\w*|ExtractAudio|\w*Convertor|ffmpeg|SponsorBlock|ModifyChapters)\]/;

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

/** A translation worth enforcing: 'unknown' is the probe's "cannot tell", not a request. */
function requestedTranslation(request: DownloadRequest): string | undefined {
  const t = request.translation?.trim();
  return t && t !== 'unknown' ? t : undefined;
}

function translationLabel(translation: string): string {
  return translation.charAt(0).toUpperCase() + translation.slice(1);
}

export class DownloadEngine {
  private tasks = new Map<string, ActiveTask>();
  private records = new Map<string, DownloadRecord>();
  private requests = new Map<string, DownloadRequest>();

  /** Queued download ids, in start order. */
  private queue: string[] = [];
  private scheduleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Removed while their process was still exiting; deleted in close(). */
  private pendingRemoval = new Set<string>();

  private maxConcurrent = 3;
  private lastStartAt = new Map<string, number>();
  private pumpTimer: ReturnType<typeof setTimeout> | undefined;
  private pumping = false;
  private pumpAgain = false;

  private online = true;
  private offlineTimer: ReturnType<typeof setTimeout> | undefined;
  private networkRetries = new Map<string, number>();

  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly stateStore: StateStore;

  private lastEmitAt = new Map<string, number>();
  private trailingEmit = new Map<string, ReturnType<typeof setTimeout>>();
  private lastPending = -1;
  /**
   * Called when the number of downloads with work left changes. Main drives the
   * tray tooltip and dock badge from this; the renderer used to compute the
   * count and send it back over IPC on every single progress event.
   */
  onPendingChange: ((count: number) => void) | null = null;

  constructor(private readonly getWindow: () => BrowserWindow | null) {
    this.stateStore = new StateStore();
    this.restoreState();
  }

  // ───────────────────────────────────────────────────────────────── Lifecycle

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, n);
    log.info(`[engine] maxConcurrent set to ${this.maxConcurrent}`);
    this.pump();
  }

  /** Restore persisted state on startup. */
  private restoreState(): void {
    const { records, requests } = this.stateStore.load();
    for (const r of records) this.records.set(r.id, r);
    for (const [id, req] of requests) this.requests.set(id, req);

    for (const record of records) {
      if (record.status === 'queued') {
        this.queue.push(record.id);
      } else if (record.status === 'scheduled') {
        // Scheduled downloads used to be persisted as 'queued' with their timer
        // lost, so every restart started them immediately.
        const at = this.requests.get(record.id)?.scheduledAt;
        if (at && Date.parse(at) > Date.now()) {
          this.arm(record.id, at);
        } else {
          record.status = 'queued';
          record.waitReason = undefined;
          this.queue.push(record.id);
        }
      }
    }
    this.sweepStaging();
    log.info(`[engine] Restored ${records.length} records, queue length: ${this.queue.length}`);
  }

  /**
   * Remove staging directories nothing can resume from.
   *
   * A crash, a kill, or a job removed while its process was dying could leave
   * `.streamdock-incomplete/<id>` behind forever (one sat in Isaac's Downloads
   * folder). Only a paused, queued or scheduled download can still use its
   * partial files; everything else under the staging folder is debris.
   */
  private sweepStaging(): void {
    const resumable = new Set(
      [...this.records.values()]
        .filter((r) => r.status === 'paused' || r.status === 'queued' || r.status === 'scheduled')
        .map((r) => r.id),
    );
    const dirs = new Set<string>([...this.requests.values()].map((r) => r.outputDir));
    try { dirs.add(persistence.getSettings().downloadDir); } catch { /* settings unreadable: sweep what we know */ }
    for (const dir of dirs) {
      if (!dir) continue;
      const staging = join(dir, STAGING_DIR_NAME);
      try {
        if (!existsSync(staging)) continue;
        for (const entry of readdirSync(staging)) {
          if (!resumable.has(entry)) rmSync(join(staging, entry), { recursive: true, force: true });
        }
        if (readdirSync(staging).length === 0) rmSync(staging, { recursive: true, force: true });
      } catch (err) {
        log.debug(`[engine] Could not sweep ${staging}:`, err);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────── Persistence

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.saveNow(), SAVE_DEBOUNCE_MS);
  }

  /**
   * Write the state file now.
   *
   * Every state change used to rewrite the whole pretty-printed file
   * synchronously on the main process — queueing 100 downloads cost 103 writes
   * and ~420 ms of a blocked UI thread. Ordinary changes are debounced; this
   * runs directly only where durability is the point (a deletion the user asked
   * for, and shutdown).
   */
  private saveNow(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.stateStore.save(Array.from(this.records.values()), this.requests);
  }

  // ─────────────────────────────────────────────────────────────── Public API

  list(): DownloadRecord[] {
    const order: Record<DownloadStatus, number> = {
      running: 0, resolving: 1, queued: 2, scheduled: 3, paused: 4, failed: 5, completed: 6, cancelled: 7,
    };
    return Array.from(this.records.values()).sort((a, b) => {
      const byStatus = (order[a.status] ?? 9) - (order[b.status] ?? 9);
      return byStatus !== 0 ? byStatus : Date.parse(b.createdAt) - Date.parse(a.createdAt);
    });
  }

  /** Downloads holding a slot right now (resolving or running). */
  activeCount(): number { return this.tasks.size; }

  /** Downloads that will still do something if the app stays open. */
  pendingCount(): number {
    return this.tasks.size + this.queue.length + this.scheduleTimers.size;
  }

  clearRecords(scope: 'all' | 'completed' | 'failed' | 'cancelled' = 'all'): void {
    for (const [id, record] of this.records) {
      const matches = scope === 'all' ? TERMINAL_STATUSES.has(record.status) : record.status === scope;
      if (matches && !this.tasks.has(id)) {
        this.records.delete(id);
        this.requests.delete(id);
      }
    }
    this.saveNow();
  }

  /**
   * Remove one download from the list — the engine's copy, not just the row.
   *
   * "Remove" used to be renderer-only: the row vanished, the engine kept the
   * record, and it came back on the next launch. A finished download is deleted
   * here outright. An active one is cancelled first, and — if its process is
   * still winding down — deleted when it closes, so a late progress event
   * cannot recreate it.
   *
   * @returns true when the download is gone or will be once its process exits.
   */
  remove(id: string): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    if (!TERMINAL_STATUSES.has(record.status) || this.tasks.has(id)) {
      this.cancel(id);
      if (this.tasks.has(id)) {
        this.pendingRemoval.add(id);
        return true;
      }
    }
    this.records.delete(id);
    this.requests.delete(id);
    this.saveNow();
    this.getWindow()?.webContents.send(IPC.EVENT_DOWNLOAD_REMOVED, [id]);
    return true;
  }

  /** Begin a new download: queued (or scheduled), started when the scheduler allows. */
  start(request: DownloadRequest): DownloadRecord {
    // EverythingMoe (and similar) are curated *indexes* of other streaming sites,
    // not media pages themselves — see REFERENCE_HOSTS in url-router.ts. Refuse to
    // enqueue rather than let yt-dlp/manifest-probe burn a full extraction attempt
    // against a page that was never meant to be downloaded from directly.
    const refHost = extractHost(request.url);
    if (REFERENCE_HOSTS().some((d) => refHost === d || refHost.endsWith(`.${d}`))) {
      throw new Error(
        "This is a reference index of streaming sites, not a direct media page. Open one of its listed sources, then paste that page's URL into StreamDock."
      );
    }

    if (!existsSync(request.outputDir)) mkdirSync(request.outputDir, { recursive: true });

    const id = randomUUID();
    const scheduled = Boolean(request.scheduledAt && Date.parse(request.scheduledAt) > Date.now());
    const record: DownloadRecord = {
      id,
      url: request.url,
      mode: request.mode,
      // The probe already resolved the real title; use it. Falling back to the
      // literal string "Video download" for every queued item is what made a
      // finished batch indistinguishable in the UI.
      title: request.mode === 'stream'
        ? 'Live stream capture'
        : (request.displayTitle?.trim() || request.titleHint?.trim() || 'Video download'),
      status: scheduled ? 'scheduled' : 'queued',
      revision: 0,
      progress: 0,
      speed: '',
      eta: '',
      createdAt: new Date().toISOString(),
      priority: request.priority ?? 100,
      thumbnail: request.thumbnail,
      bytesDownloaded: 0,
      bytesTotal: 0,
      detectedFormat: detectFormat(request.url).format,
      requestedTranslation: requestedTranslation(request),
    };

    this.records.set(id, record);
    this.requests.set(id, request);
    this.emitProgress(record, true);

    if (scheduled) this.arm(id, request.scheduledAt!);
    else this.enqueue(id);
    this.scheduleSave();
    return { ...record };
  }

  pause(id: string): void {
    const record = this.records.get(id);
    if (!record) return;
    const task = this.tasks.get(id);

    switch (record.status) {
      case 'scheduled':
        this.disarm(id);
        this.transition(record, 'paused');
        return;
      case 'queued':
        this.dequeue(id);
        this.transition(record, 'paused');
        this.pump();
        return;
      case 'resolving':
        this.transition(record, 'paused');
        if (task) this.release(id, task);
        log.info(`[engine] Download ${id} paused while resolving its manifest`);
        this.pump();
        return;
      case 'running':
        this.transition(record, 'paused');
        if (task) this.stop(id, task, 'pause');
        log.info(`[engine] Download ${id} paused at ${record.progress.toFixed(1)}%`);
        return;
      default:
        return;
    }
  }

  cancel(id: string): void {
    const record = this.records.get(id);
    if (!record || record.status === 'completed' || record.status === 'cancelled') return;
    const task = this.tasks.get(id);
    const request = this.requests.get(id);

    this.disarm(id);
    this.dequeue(id);
    this.transition(record, 'cancelled');

    if (task?.process) {
      // close() cleans up once the process has actually exited.
      this.stop(id, task, 'cancel');
      return;
    }
    if (task) this.release(id, task);
    this.cleanPartialFiles(record);
    this.clearStaging(request, id);
    this.requests.delete(id);
    this.networkRetries.delete(id);
    this.pump();
  }

  resume(id: string): void {
    const record = this.records.get(id);
    if (record?.status !== 'paused') return;
    this.transition(record, 'queued');
    this.enqueue(id);
  }

  retry(id: string): void {
    const record = this.records.get(id);
    if (record?.status !== 'failed' || !this.requests.has(id)) return;
    this.networkRetries.delete(id);
    this.transition(record, 'queued', { progress: 0, bytesDownloaded: 0, alreadyExisted: undefined });
    log.info(`[engine] Retrying download ${id}`);
    this.enqueue(id, true);
  }

  /** Pause or cancel everything that has not finished. */
  stopAll(mode: 'pause' | 'cancel' = 'pause'): void {
    const ids = [...this.records.values()]
      .filter((r) => r.status === 'scheduled' || r.status === 'queued' || r.status === 'resolving' || r.status === 'running')
      .map((r) => r.id);
    log.info(`[engine] stopAll (${mode}): ${ids.length} downloads`);
    for (const id of ids) {
      if (mode === 'pause') this.pause(id);
      else this.cancel(id);
    }
  }

  resumeAll(): void {
    const paused = [...this.records.values()].filter((r) => r.status === 'paused').map((r) => r.id);
    for (const id of paused) this.resume(id);
  }

  /** Called on app quit: pause what is running so it resumes on the next launch. */
  shutdown(): void {
    log.info(`[engine] Shutdown: pausing ${this.tasks.size} active downloads`);
    for (const id of [...this.tasks.keys()]) this.pause(id);
    // Scheduled downloads stay 'scheduled'; restoreState re-arms them.
    for (const timer of this.scheduleTimers.values()) clearTimeout(timer);
    this.scheduleTimers.clear();
    clearTimeout(this.pumpTimer);
    clearTimeout(this.offlineTimer);
    this.saveNow();
  }

  // ─────────────────────────────────────────────────────── State transitions

  /**
   * The only place a download's status changes.
   *
   * Refuses a move the lifecycle does not allow (logged, not thrown: an
   * illegal transition is a bug, and a bug must not take a download with it).
   * Clears what the new state must not carry: a completed row never keeps an
   * error, a paused one never keeps a speed.
   */
  private transition(record: DownloadRecord, next: DownloadStatus, patch: Partial<DownloadRecord> = {}): boolean {
    if (record.status !== next && !NEXT[record.status].includes(next)) {
      log.error(`[engine] illegal transition ${record.status} -> ${next} for ${record.id}`);
      return false;
    }
    Object.assign(record, patch);
    record.status = next;
    if (next !== 'failed') {
      record.error = undefined;
      record.errorDetail = undefined;
    }
    if (next !== 'queued' && next !== 'scheduled' && !('waitReason' in patch)) record.waitReason = undefined;
    if (next !== 'running') {
      record.speed = '';
      record.eta = '';
      record.stallMessage = undefined;
    }
    this.emitProgress(record, true);
    this.scheduleSave();
    return true;
  }

  // ───────────────────────────────────────────────────────────── Scheduling

  private arm(id: string, at: string): void {
    this.disarm(id);
    const record = this.records.get(id);
    if (record) {
      const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      record.waitReason = `Starts at ${time}`;
    }
    const timer = setTimeout(() => {
      this.scheduleTimers.delete(id);
      const r = this.records.get(id);
      if (r?.status !== 'scheduled') return;
      this.transition(r, 'queued');
      this.enqueue(id);
    }, Math.max(0, Date.parse(at) - Date.now()));
    this.scheduleTimers.set(id, timer);
  }

  private disarm(id: string): void {
    const timer = this.scheduleTimers.get(id);
    if (timer) clearTimeout(timer);
    this.scheduleTimers.delete(id);
  }

  private enqueue(id: string, front = false): void {
    if (!this.queue.includes(id)) {
      if (front) this.queue.unshift(id);
      else this.queue.push(id);
    }
    this.pump();
  }

  private dequeue(id: string): void {
    const at = this.queue.indexOf(id);
    if (at !== -1) this.queue.splice(at, 1);
  }

  private policyFor(host: string): HostPolicy {
    const { probeHostMaxConcurrent, startSpacingMs } = CONCURRENCY();
    return {
      maxConcurrent: matchesProbeHost(host) ? probeHostMaxConcurrent : Number.POSITIVE_INFINITY,
      minStartSpacingMs: startSpacingMs,
    };
  }

  /** Start whatever the scheduler allows, and tell every waiting row why it waits. */
  private pump(): void {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        this.pumpOnce();
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  private pumpOnce(): void {
    clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
    this.queue = this.queue.filter((id) => this.records.get(id)?.status === 'queued' && this.requests.has(id));

    const now = Date.now();
    const plan = planStarts({
      queue: this.queue.map((id) => ({ id, host: extractHost(this.requests.get(id)!.url) })),
      active: [...this.tasks.values()].map((t) => t.host),
      globalLimit: this.maxConcurrent,
      lastStartAt: this.lastStartAt,
      now,
      online: this.online,
      policyFor: (host) => this.policyFor(host),
    });

    for (const [id, reason] of plan.waiting) {
      const record = this.records.get(id)!;
      const text = describeWait(reason);
      if (record.waitReason !== text) {
        record.waitReason = text;
        this.emitProgress(record);
      }
    }
    for (const id of plan.start) {
      this.dequeue(id);
      this.lastStartAt.set(extractHost(this.requests.get(id)!.url), now);
      this.startRun(id);
    }
    if (plan.wakeAt !== undefined) {
      this.pumpTimer = setTimeout(() => this.pump(), Math.max(0, plan.wakeAt - now));
    }
  }

  // ──────────────────────────────────────────────────────────────── Runs

  private startRun(id: string): void {
    const record = this.records.get(id)!;
    const request = this.requests.get(id)!;
    const host = extractHost(request.url);
    const resolve = !request.manifestUrl && matchesProbeHost(host);

    const task: ActiveTask = {
      process: null,
      record,
      request,
      host,
      spawnUrl: request.manifestUrl ?? request.url,
      stderr: '',
      manifestAttempted: Boolean(request.manifestUrl),
      watch: new StallWatch((stalled) => this.onStall(id, stalled)),
      abort: new AbortController(),
      startedAt: Date.now(),
      movedFiles: [],
      settled: false,
    };
    this.tasks.set(id, task);
    this.transition(record, resolve ? 'resolving' : 'running', { alreadyExisted: undefined });

    this.runAttempt(id, task, resolve).catch((err) => void this.settleFailure(id, task, err));
  }

  private async runAttempt(id: string, task: ActiveTask, resolve: boolean): Promise<void> {
    let referer = task.request.manifestReferer;

    if (resolve) {
      const wanted = task.record.requestedTranslation;
      log.info(`[engine] Resolving manifest for ${task.request.url}${wanted ? ` (${wanted})` : ''}`);
      const result = await this.resolveManifest(id, task);
      // Paused, cancelled or resumed into a new attempt while this was pending:
      // this attempt no longer owns the job and must not spawn anything.
      if (this.tasks.get(id) !== task) return;

      const language = this.languageFailure(wanted, result);
      if (language) {
        this.settle(task);
        this.release(id, task);
        this.fail(id, task.record, language);
        return;
      }
      if (result) {
        log.info(`[engine] Manifest resolved: ${result.manifestUrl}`);
        task.spawnUrl = result.manifestUrl;
        task.manifestAttempted = true;
        task.cookiesFile = result.cookiesFile;
        referer = result.referer;
        task.record.resolvedTranslation = result.translation;
      } else {
        log.info('[engine] No manifest found; letting yt-dlp try the page itself.');
      }
      this.transition(task.record, 'running');
    }

    this.spawnYtDlp(id, task, referer);
  }

  /**
   * Resolve the stream for a page, retrying once.
   *
   * With a language requested, only a manifest the extractor proved to be that
   * language counts; an unproven one earns the second attempt. The old path
   * was extract, then yt-dlp on the page, then a second extraction *without*
   * the language or a ceiling (retryWithManifest) — a copy of the whole spawn
   * pipeline that had drifted from the first.
   */
  private async resolveManifest(id: string, task: ActiveTask): Promise<ManifestResult | null> {
    const wanted = task.record.requestedTranslation;
    let best: ManifestResult | null = null;
    for (let attempt = 1; attempt <= EXTRACTION_ATTEMPTS; attempt++) {
      const result = await this.withCeiling(
        extractManifest(task.request.url, wanted, task.abort.signal),
        task.request.url,
      ).catch((err) => {
        log.warn('[engine] Manifest extraction failed:', err);
        return null;
      });
      if (this.tasks.get(id) !== task) return null;
      if (result && (!wanted || result.languageOutcome === 'selected')) return result;
      if (result) best = result;
      if (result?.languageOutcome === 'absent') break;
      if (attempt < EXTRACTION_ATTEMPTS) log.info(`[engine] Extraction attempt ${attempt} gave no usable manifest; retrying`);
    }
    return best;
  }

  /**
   * The message for a download whose requested language cannot be delivered,
   * or null when it can (or none was requested).
   *
   * Isaac's decision: an episode that cannot be proven to be the language he
   * asked for fails, clearly, instead of arriving as the site default. Before,
   * "selection timed out, taking the default stream" was logged and the Sub
   * stream saved as if it were the Dub one.
   */
  private languageFailure(wanted: string | undefined, result: ManifestResult | null): string | null {
    if (!wanted) return null;
    const label = translationLabel(wanted);
    if (!result) return `Could not find the ${label} stream for this episode.`;
    if (result.languageOutcome === 'selected') return null;
    if (result.languageOutcome === 'absent') return `${label} is not available for this episode.`;
    return `Could not confirm the ${label} stream for this episode, so it was not downloaded. Retry it, or choose another language.`;
  }

  private withCeiling<T>(work: Promise<T>, pageUrl: string): Promise<T | null> {
    // Hard ceiling on extraction. Two separate hangs have been found in that
    // path — a raw fetch with no timeout, and a last-resort executeJavaScript
    // that never settles against a stuck renderer — and because probe hosts run
    // one at a time, either one stalls every remaining episode.
    //
    // The timer is cleared once the race settles. It used to be left running,
    // so every extraction — including ones that succeeded in 20s — logged
    // "exceeded 120000ms" two minutes later (57 of them in one real session).
    let ceiling: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      work,
      new Promise<null>((resolve) => {
        ceiling = setTimeout(() => {
          log.warn(`[engine] Manifest extraction exceeded ${MANIFEST_EXTRACTION_CEILING_MS}ms for ${pageUrl}`);
          resolve(null);
        }, MANIFEST_EXTRACTION_CEILING_MS);
      }),
    ]).finally(() => clearTimeout(ceiling));
  }

  private spawnYtDlp(id: string, task: ActiveTask, referer: string | undefined): void {
    const { request, record } = task;
    // A manifest URL names nothing, so a VOD downloaded from one is named from
    // the UI's title. yt-dlp names everything else from its own metadata.
    const forcedTitle = task.manifestAttempted && request.mode === 'video'
      ? (request.titleHint?.trim() || request.displayTitle?.trim() || undefined)
      : undefined;
    const args = this.buildArgs(
      { ...request, url: task.spawnUrl },
      resolveBinary('ffmpeg'),
      request.url,
      referer,
      forcedTitle,
      this.stagingDir(request, id),
    );

    // Inject --cookies before the -- URL separator if the manifest extractor
    // captured session cookies from the embed CDN response.
    if (task.cookiesFile && existsSync(task.cookiesFile)) {
      const sepIdx = args.indexOf('--');
      if (sepIdx !== -1) args.splice(sepIdx, 0, '--cookies', task.cookiesFile);
      else args.push('--cookies', task.cookiesFile);
    }

    // The native binary loads the bundled plugins through --plugin-dirs roots
    // (verified in session 13). The Python-module path this replaced ran up to
    // three synchronous `python -m yt_dlp --version` probes on the main
    // process per failed extraction, and on machines without Python — Isaac's —
    // fell back to the native binary anyway.
    const command = resolveBinary('yt-dlp');
    log.info(`[engine] Spawning download ${id} | format=${record.detectedFormat} | cmd=${[command, ...args].join(' ').substring(0, 400)}`);

    const child = spawn(command, args, { windowsHide: true });
    task.process = child;
    task.startedAt = Date.now();

    child.stdout?.on('data', (chunk: Buffer) => this.consume(id, chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (this.tasks.get(id) === task) {
        task.stderr += text;
        if (task.stderr.length > 65_536) task.stderr = task.stderr.slice(-65_536);
      }
      this.consume(id, text);
    });
    child.on('error', (error) => void this.settleFailure(id, task, error));
    child.on('close', (code) => this.close(id, code, child));
  }

  private onStall(id: string, stalled: boolean): void {
    const task = this.tasks.get(id);
    if (!task || task.record.status !== 'running') return;
    const message = stalled ? STALL_MESSAGE : undefined;
    if (task.record.stallMessage === message) return;
    task.record.stallMessage = message;
    this.emitProgress(task.record);
  }

  /** Release a task's slot and resources. Its record is the caller's business. */
  private release(id: string, task: ActiveTask): void {
    task.watch.dispose();
    task.abort.abort();
    if (this.tasks.get(id) === task) this.tasks.delete(id);
    if (task.cookiesFile) {
      try { rmSync(task.cookiesFile, { force: true }); } catch { /* non-fatal */ }
    }
  }

  private settle(task: ActiveTask): boolean {
    if (task.settled) return false;
    task.settled = true;
    return true;
  }

  // ─────────────────────────────────────────────── Process Management

  /**
   * Kill a process safely, terminating the FULL process tree cross-platform.
   *
   * On Windows: uses `taskkill /pid <PID> /T /F` to recursively kill the tree.
   * On macOS/Linux: uses `pkill -P <PID>` to kill children first, then SIGTERM/SIGKILL on parent.
   * Falls back to Node's proc.kill() if native commands fail.
   */
  private stop(id: string, task: ActiveTask, reason: string): void {
    const { process: proc } = task;
    task.watch.dispose();

    if (!proc || proc.killed || proc.exitCode !== null) return;

    const pid = proc.pid;
    log.debug(`[engine] Killing process tree for ${id} (reason=${reason}, pid=${pid})`);

    if (process.platform === 'win32' && pid !== undefined) {
      // Windows: taskkill /T /F kills the entire process tree atomically
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], (err) => {
        if (err) {
          log.warn(`[engine] taskkill failed for pid ${pid}: ${err.message}. Falling back to proc.kill().`);
          try { proc.kill(); } catch { /* already dead */ }
        }
      });
    } else if (pid !== undefined) {
      // macOS/Linux: kill children first with pkill -P, then the parent.
      execFile('pkill', ['-P', String(pid)], (err) => {
        if (err && err.code !== 1) log.warn(`[engine] pkill -P failed for pid ${pid}: ${err.message}`);
        setTimeout(() => {
          proc.kill('SIGTERM');
          const killTimer = setTimeout(() => {
            if (!proc.killed && proc.exitCode === null) {
              log.warn(`[engine] Process for ${id} did not exit after SIGTERM, sending SIGKILL`);
              try { proc.kill('SIGKILL'); } catch { /* already dead */ }
            }
          }, 3_000);
          proc.once('exit', () => clearTimeout(killTimer));
        }, 500);
      });
    } else {
      proc.kill('SIGTERM');
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
      // path.dirname, not lastIndexOf('/') || lastIndexOf('\\'): -1 is truthy,
      // so that form never took the backslash branch and skipped .part/.ytdl
      // cleanup on every Windows cancel.
      const dir = dirname(record.outputPath);
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

  // ──────────────────────────────────────────────────────────── Output Parsing

  private consume(id: string, chunk: string): void {
    const task = this.tasks.get(id);
    if (!task) return;

    for (const line of chunk.split(/[\r\n]+/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      log.debug(`[engine:${id}] ${trimmed.substring(0, 200)}`);

      if (POSTPROCESS_LINE.test(trimmed)) task.watch.idle();

      // `--no-overwrites` makes yt-dlp skip an existing file and exit 0. That
      // is correct behaviour, but it must not be presented as a fresh download:
      // a stale 200MB file made an episode "complete" in six seconds, which
      // silently masked whether a fix had worked at all.
      const skipped = trimmed.match(/^\[download\]\s+(.+?)\s+has already been downloaded/i);
      if (skipped) {
        task.record.alreadyExisted = true;
        task.record.outputPath = skipped[1].trim();
      }

      // The finishing move out of the staging directory. This is the last word
      // on where the file actually lives: every earlier Destination/Merger line
      // points inside `temp:`, so without this "Open file" and "Show in folder"
      // would target a staging path that no longer exists.
      const moved = trimmed.match(/\[MoveFiles\]\s+Moving file\s+"(.+?)"\s+to\s+"(.+?)"/i);
      if (moved) {
        task.movedFiles.push(moved[2].trim());
        task.record.outputPath = moved[2].trim();
        task.record.title = basename(moved[2].trim()).replace(/\.[^.]+$/, '');
        this.emitProgress(task.record);
        continue;
      }

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
        task.watch.progress();
        const pct = parseFloat(progress[1]) || 0;
        task.record.progress = Math.min(pct, 99.9);
        if (progress[2]) {
          task.record.bytesTotal = parseBytes(progress[2]);
          task.record.bytesDownloaded = Math.round((pct / 100) * task.record.bytesTotal);
        }
        if (progress[3]) task.record.speed = progress[3];
        if (progress[4]) task.record.eta = progress[4];
        this.emitProgress(task.record);
        continue;
      }

      // Thumbnail extraction
      const thumb = trimmed.match(/thumbnail[:\s]+(.+\.(jpg|jpeg|png|webp))/i);
      if (thumb) {
        task.record.thumbnail = thumb[1].trim();
      }

      // Error lines are deliberately NOT turned into record state here. Only
      // the exit decides whether a download failed (close → settleFailure,
      // which classifies the whole stderr with context). Classifying per line
      // put yt-dlp's own *retried* errors — "[download] Got error: … timed out
      // … Retrying (1/3)..." — on the record, where exit 0 never cleared them:
      // rows marked Completed with "Connection timed out" under them, plus a
      // "Failed:" toast for a download that did not fail.
    }
  }

  // ──────────────────────────────────────────────────────────── Process Events

  private close(id: string, code: number | null, child: ChildProcess): void {
    const task = this.tasks.get(id);
    if (!task || task.process !== child) return; // stale event from an earlier attempt
    this.release(id, task);

    const { record } = task;
    const elapsed = ((Date.now() - task.startedAt) / 1000).toFixed(1);
    log.info(`[engine] Download ${id} closed | code=${code} | elapsed=${elapsed}s | bytes=${record.bytesDownloaded}`);

    if (record.status === 'cancelled' || record.status === 'paused') {
      this.settle(task);
      // Clean partial files on cancel, keep them on pause (for resume) — a
      // paused download resumes from the .part still sitting in its staging
      // directory, so that directory must survive a pause.
      if (record.status === 'cancelled') {
        this.cleanPartialFiles(record);
        this.clearStaging(task.request, id);
        this.requests.delete(id);
        this.networkRetries.delete(id);
      }
      if (this.pendingRemoval.delete(id)) {
        this.records.delete(id);
        this.getWindow()?.webContents.send(IPC.EVENT_DOWNLOAD_REMOVED, [id]);
      }
      this.scheduleSave();
      this.pump();
      return;
    }

    if (code === 0) {
      this.settle(task);
      // yt-dlp has moved the finished file to the download folder; whatever is
      // left in staging is scratch.
      this.clearStaging(task.request, id);
      this.networkRetries.delete(id);
      this.transition(record, 'completed', { progress: 100 });
      this.getWindow()?.webContents.send(IPC.EVENT_DOWNLOAD_COMPLETE, { ...record });
      log.info(`[engine] Download ${id} completed: ${record.title}`);
      this.pump();
      return;
    }

    this.retractMovedFiles(task);
    void this.settleFailure(id, task, new Error(task.stderr || `yt-dlp exited with code ${code ?? 'unknown'}`));
  }

  /**
   * Decide what a failed attempt means.
   *
   * A network failure while the internet is unreachable is not the download's
   * fault: the job goes back to the front of the queue and the queue waits for
   * the network. When DNS died in the middle of a 53-episode run, the old engine
   * started and failed every remaining episode in turn — ~45 of them in ten
   * minutes, each reported as "Something went wrong".
   */
  private async settleFailure(id: string, task: ActiveTask, error: unknown): Promise<void> {
    if (!this.settle(task)) return;
    if (this.tasks.get(id) === task) this.release(id, task);
    const { record } = task;
    const stillActive = () => record.status === 'running' || record.status === 'resolving';
    if (!stillActive()) {
      this.pump();
      return;
    }

    if (isNetworkFailure(error)) {
      const tries = (this.networkRetries.get(id) ?? 0) + 1;
      this.networkRetries.set(id, tries);
      if (tries <= MAX_NETWORK_RETRIES && !(await isInternetReachable())) {
        if (!stillActive()) return;
        log.warn(`[engine] Download ${id} lost the network; holding it (attempt ${tries}/${MAX_NETWORK_RETRIES})`);
        this.transition(record, 'queued');
        this.queue.unshift(id);
        this.goOffline();
        return;
      }
    }
    if (!stillActive()) return;

    const message = classifyEngineFailure(error, { manifestAttempted: task.manifestAttempted, url: task.spawnUrl });
    this.fail(id, record, message, toErrorDetail(error));
  }

  private fail(id: string, record: DownloadRecord, message: string, detail?: string | null): void {
    log.error(`[engine] Download ${id} failed: ${message}`);
    if (detail) log.error(`[engine] Download ${id} engine output:\n${detail}`);
    // A failed download leaves nothing usable behind — drop the staged partials
    // rather than letting them accumulate in a hidden folder forever.
    this.clearStaging(this.requests.get(id), id);
    this.networkRetries.delete(id);
    this.transition(record, 'failed', { error: message, errorDetail: detail ?? undefined });
    this.getWindow()?.webContents.send(IPC.EVENT_DOWNLOAD_ERROR, { ...record });
    this.pump();
  }

  private goOffline(): void {
    if (this.online) {
      this.online = false;
      log.warn('[engine] Network unreachable; holding the queue');
      const check = async (): Promise<void> => {
        if (await isInternetReachable()) {
          this.online = true;
          this.offlineTimer = undefined;
          log.info('[engine] Network is back; resuming the queue');
          this.pump();
        } else {
          this.offlineTimer = setTimeout(() => void check(), OFFLINE_RECHECK_MS);
        }
      };
      this.offlineTimer = setTimeout(() => void check(), OFFLINE_RECHECK_MS);
    }
    this.pump();
  }

  /**
   * Delete what a failed single-item run already delivered to the folder.
   *
   * Only for a spawn that covers exactly one item: in a playlist run every
   * earlier item was moved after finishing cleanly, and a later item's failure
   * says nothing about them. The "has already been downloaded" path never adds
   * to movedFiles, so a file that pre-dated this run is never touched.
   */
  private retractMovedFiles(task: ActiveTask): void {
    if (task.request.isPlaylist || task.request.playlistItems) return;
    for (const file of task.movedFiles) {
      try {
        rmSync(file, { force: true });
        log.warn(`[engine] Removed ${basename(file)}: the download failed after it was moved into the folder`);
      } catch (err) {
        log.warn(`[engine] Could not remove ${basename(file)} after a failed download:`, err);
      }
    }
    if (task.record.outputPath && task.movedFiles.includes(task.record.outputPath)) {
      task.record.outputPath = undefined;
    }
  }

  // ──────────────────────────────────────────────── Argument Construction

  private resolveFinalUrl(url: string): string {
    const host = extractHost(url);
    if (host === 'open.spotify.com' || host === 'spotify.com') {
      return `ytsearch1:${url}`;
    }
    return url;
  }

  private buildArgs(
    request: DownloadRequest,
    ffmpeg: string,
    originalPageUrl?: string,
    referer?: string,
    forcedTitle?: string,
    stagingDir = join(request.outputDir, STAGING_DIR_NAME, 'shared'),
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
      // Generous, because a missing fragment now fails the download instead
      // of being skipped (below): 10 tries with exponential sleep capped at
      // 10s rides out roughly a minute of network trouble.
      '--fragment-retries', '10',
      '--retry-sleep', 'fragment:exp=1:10',
      // yt-dlp's default for HLS/DASH VOD is to *skip* a fragment it cannot
      // fetch and carry on. On a DNS drop that produced a 59MB "episode"
      // (a full one is ~330MB), moved into the folder as finished. Live
      // capture keeps the default: a live edge genuinely loses fragments.
      ...(request.mode === 'stream' ? [] : ['--abort-on-unavailable-fragments']),
      // Rate limiting: be polite
      '--sleep-requests', '0.5',
      ...(this.buildImpersonationArgs(request, originalPageUrl, referer)),
      ...buildPluginDirArgs(request.pluginDirs),
      // Relative on purpose: the destination is supplied separately as
      // `--paths home:`, which is what lets `--paths temp:` stage the download
      // elsewhere. An absolute `-o` overrides both and would put every partial
      // file, fragment and pre-mux artefact straight into the user's folder.
      '-o', buildOutputTemplate({ ...request, forcedTitle }),
      // Atomic delivery: everything in progress — .part files, per-format
      // fragments, the pre-mux stream, subtitle files awaiting embedding — is
      // written under `temp:`, and yt-dlp moves only the finished file into
      // `home:` at the very end. So the download folder never shows a partial
      // file the user could open or an AV scanner could quarantine mid-write.
      '--paths', `home:${request.outputDir}`,
      '--paths', `temp:${stagingDir}`,
      // '--write-thumbnail' is intentionally omitted: passing it without '--embed-thumbnail'
      // causes yt-dlp to leave a loose .webp/.jpg file next to the merged .mp4 (Bug 1 fix).
      // Re-downloads must never silently clobber an existing file at the
      // resolved output path — skip instead of overwriting when one is already there.
      '--no-overwrites',
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

    this.applyYtDlpOptions(args);

    args.push('--', finalUrl);
    return args;
  }

  private applyYtDlpOptions(args: string[]): void {
    const settings = persistence.getSettings();
    const opts = settings.ytdlpOptions;
    if (!opts) return;

    // embedSubs deliberately does NOT appear here. It used to append
    // --embed-subs after the per-download subtitle decision had already been
    // made, which meant "None" still embedded and "Sidecar" embedded as well as
    // writing the file. It is now the *default value* of the per-download
    // picker (see subtitle-args.ts), resolved before any argument is built.
    if (opts.embedMetadata && !args.includes('--embed-metadata')) {
      args.push('--embed-metadata');
    }
    if (opts.sponsorBlock) {
      args.push('--sponsorblock-remove', 'all');
    }
    if (opts.customArgs) {
      // Split by space but ignore spaces inside quotes?
      // A simple split by space is a basic approach, or we can use a regex if needed.
      // But we just need to avoid command injection.
      // Sanitizing [;&|$()]
      const sanitized = opts.customArgs.replace(/[;&|$()]/g, '');
      const parts = sanitized.split(/\s+/).filter(Boolean);
      args.push(...parts);
    }
  }

  private applyLanguageAndSubtitleArgs(args: string[], request: DownloadRequest): void {
    const packaging = request.downloadPackaging;

    // "Subtitles only" still needs --skip-download; the write flags themselves
    // come from buildSubtitleArgs below, so they are not duplicated here.
    if (request.subsOnly || packaging === 'subs-only') {
      args.push('--skip-download');
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

    // One function owns the entire subtitle decision and returns the complete
    // flag set. Nothing below may add subtitle arguments — that is exactly the
    // shape of bug this replaced.
    args.push(...buildSubtitleArgs(request));
  }

  /**
   * Staging directory for one download's in-progress files.
   *
   * Inside the destination folder so the finishing move is a same-volume
   * rename rather than a full copy of a multi-gigabyte file, but in a dot
   * directory of its own so nothing half-written is ever sitting next to the
   * user's finished media — not a `.part`, not a `.f137.mp4` fragment, not a
   * pre-mux `.webm`, and not a file an antivirus scanner or a double-click
   * can reach mid-write.
   */
  private stagingDir(request: DownloadRequest, id: string): string {
    return join(request.outputDir, STAGING_DIR_NAME, id);
  }

  /** Remove a download's staging directory, and the parent once it runs dry. */
  private clearStaging(request: DownloadRequest | undefined, id: string): void {
    if (!request?.outputDir) return;
    try {
      rmSync(this.stagingDir(request, id), { recursive: true, force: true });
      const parent = join(request.outputDir, STAGING_DIR_NAME);
      if (existsSync(parent) && readdirSync(parent).length === 0) {
        rmSync(parent, { recursive: true, force: true });
      }
    } catch (err) {
      log.debug('[engine] Could not clear staging directory:', err);
    }
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

  /** Send a download's state, coalesced unless `urgent` (a status change). */
  private emitProgress(record: DownloadRecord, urgent = false): void {
    const since = Date.now() - (this.lastEmitAt.get(record.id) ?? 0);
    if (!urgent && since < PROGRESS_INTERVAL_MS) {
      if (!this.trailingEmit.has(record.id)) {
        this.trailingEmit.set(record.id, setTimeout(() => {
          this.trailingEmit.delete(record.id);
          this.sendRecord(record);
        }, PROGRESS_INTERVAL_MS - since));
      }
      return;
    }
    clearTimeout(this.trailingEmit.get(record.id));
    this.trailingEmit.delete(record.id);
    this.sendRecord(record);
  }

  private sendRecord(record: DownloadRecord): void {
    // A removed download is never announced again — a late event for an id
    // the renderer has dropped is exactly how rows used to come back.
    if (this.records.get(record.id) !== record) return;
    record.revision += 1;
    this.lastEmitAt.set(record.id, Date.now());
    this.getWindow()?.webContents.send(IPC.EVENT_DOWNLOAD_PROGRESS, { ...record });

    const pending = this.pendingCount();
    if (pending !== this.lastPending) {
      this.lastPending = pending;
      this.onPendingChange?.(pending);
    }
  }
}

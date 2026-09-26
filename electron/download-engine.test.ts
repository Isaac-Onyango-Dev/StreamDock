// DownloadEngine behaviour, driven through a fake yt-dlp process and a fake
// manifest extractor. The engine is otherwise real: state-store, url-router,
// error classification and argument building all run as shipped.
//
// `it.fails` marks a known defect from the session-22 audit: the test states
// the correct behaviour and currently fails. Each fix flips exactly one of them
// to `it`, so a regression shows up as a red test rather than a silent pass.
import { EventEmitter } from 'events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir = mkdtempSync(join(tmpdir(), 'streamdock-engine-'));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? userDataDir : join(userDataDir, 'downloads')),
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
  net: { request: () => ({ on: () => undefined, end: () => undefined }) },
}));

// ── Fake yt-dlp ──────────────────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  static nextPid = 1000;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid = FakeChild.nextPid++;
  killed = false;
  exitCode: number | null = null;

  constructor(readonly command: string, readonly args: string[]) {
    super();
  }

  /** Print lines the way yt-dlp does with --newline. */
  out(...lines: string[]): void {
    this.stdout.emit('data', Buffer.from(lines.map((l) => `${l}\n`).join('')));
  }

  exit(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit('exit', code);
    this.emit('close', code);
  }

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.exit(1));
    return true;
  }
}

const children: FakeChild[] = [];

vi.mock('child_process', () => {
  const spawn = vi.fn((command: string, args: string[]) => {
    const child = new FakeChild(command, args);
    children.push(child);
    return child;
  });
  // taskkill on Windows, pkill elsewhere: both end with the child exiting.
  const execFile = vi.fn((command: string, args: string[], cb?: (err: unknown) => void) => {
    if (command === 'taskkill') {
      const pid = Number(args[1]);
      queueMicrotask(() => {
        children.find((c) => c.pid === pid)?.exit(1);
        cb?.(null);
      });
    } else {
      queueMicrotask(() => cb?.({ code: 1 }));
    }
  });
  return { spawn, execFile, default: { spawn, execFile } };
});

// ── Fake extractor ───────────────────────────────────────────────────────────

type ManifestResult = { originalUrl: string; manifestUrl: string; type: string; referer?: string };
const extractions: Array<{ url: string; resolve: (r: ManifestResult | null) => void }> = [];

vi.mock('./manifest-extractor', () => ({
  extractManifest: vi.fn(
    (url: string) =>
      new Promise<ManifestResult | null>((resolve) => {
        extractions.push({ url, resolve });
      }),
  ),
}));

vi.mock('./binary-resolver', () => ({
  resolveBinary: () => 'ffmpeg',
  resolveYtDlpCommand: () => ({ command: 'yt-dlp', args: [], type: 'native' }),
  buildPluginDirArgs: () => [],
}));

const { DownloadEngine } = await import('./download-engine');
type Engine = InstanceType<typeof DownloadEngine>;
type DlRecord = ReturnType<Engine['list']>[number];

// ── Harness ──────────────────────────────────────────────────────────────────

const YOUTUBE = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const episode = (n: number) => `https://anikoto.cz/watch/one-piece-odmau/ep-${n}`;
const CDN = (n: number) => `https://fetch.nexabloom.top/anime/abc/${n}/master.m3u8?token=t`;

let outputDir = '';
let sent: Array<{ channel: string; record: DlRecord }> = [];
const fakeWindow = { webContents: { send: (channel: string, record: DlRecord) => sent.push({ channel, record }) } };

function newEngine(): Engine {
  // The engine only calls webContents.send on what the getter returns.
  return new DownloadEngine(() => fakeWindow as never);
}

/** Let queued microtasks, the kill path and the 3s spawn stagger run. */
const settle = (ms = 3_100) => vi.advanceTimersByTimeAsync(ms);

const find = (engine: Engine, id: string) => engine.list().find((r) => r.id === id)!;
const running = (engine: Engine) => engine.list().filter((r) => r.status === 'running');
const childFor = (url: string) => children.filter((c) => c.args.includes(url)).at(-1)!;

function startVideo(engine: Engine, url: string, extra: Record<string, unknown> = {}) {
  return engine.start({ url, mode: 'video', outputDir, ...extra });
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-26T12:00:00Z') });
  userDataDir = mkdtempSync(join(tmpdir(), 'streamdock-engine-'));
  outputDir = join(userDataDir, 'out');
  mkdirSync(outputDir, { recursive: true });
  children.length = 0;
  extractions.length = 0;
  sent = [];
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(userDataDir, { recursive: true, force: true });
});

// ── What already works (must survive the refactor) ───────────────────────────

describe('lifecycle that works today', () => {
  it('a successful run ends completed at 100% with the moved file as its path', async () => {
    const engine = newEngine();
    const { id } = startVideo(engine, YOUTUBE);
    const child = childFor(YOUTUBE);
    const final = join(outputDir, 'Me at the zoo.mp4');
    child.out(
      '[download]  42.0% of   10.00MiB at    1.00MiB/s ETA 00:06',
      `[MoveFiles] Moving file "${join(outputDir, '.streamdock-incomplete', id, 'x.mp4')}" to "${final}"`,
    );
    child.exit(0);
    await settle(10);

    const record = find(engine, id);
    expect(record.status).toBe('completed');
    expect(record.progress).toBe(100);
    expect(record.outputPath).toBe(final);
  });

  it('pausing a running download kills it; resuming starts a new process', async () => {
    const engine = newEngine();
    const { id } = startVideo(engine, YOUTUBE);
    engine.pause(id);
    await settle();
    expect(find(engine, id).status).toBe('paused');
    expect(engine.activeCount()).toBe(0);

    engine.resume(id);
    await settle();
    expect(find(engine, id).status).toBe('running');
    expect(children.filter((c) => c.args.includes(YOUTUBE))).toHaveLength(2);
  });

  it('cancelling a running download ends cancelled and frees its slot', async () => {
    const engine = newEngine();
    const { id } = startVideo(engine, YOUTUBE);
    engine.cancel(id);
    await settle();
    expect(find(engine, id)?.status ?? 'cancelled').toBe('cancelled');
    expect(engine.activeCount()).toBe(0);
  });

  it('holds jobs beyond the global limit in the queue and starts them as slots free', async () => {
    const engine = newEngine();
    engine.setMaxConcurrent(2);
    const urls = [1, 2, 3].map((n) => `${YOUTUBE}&n=${n}`);
    const ids = [];
    for (const url of urls) {
      ids.push(startVideo(engine, url).id);
      await settle();
    }
    expect(running(engine)).toHaveLength(2);
    expect(find(engine, ids[2]).status).toBe('queued');

    childFor(urls[0]).exit(0);
    await settle();
    expect(find(engine, ids[2]).status).toBe('running');
  });

  it('queues a second job for a probe host while the first is still running', async () => {
    const engine = newEngine();
    startVideo(engine, episode(1));
    const second = startVideo(engine, episode(2));
    await settle();
    expect(find(engine, second.id).status).toBe('queued');
    expect(extractions).toHaveLength(1);
  });
});

// ── Known defects (session 22 audit) ─────────────────────────────────────────

describe('known defects', () => {
  // Screenshot 1: rows "Completed" with "Connection timed out" under them.
  // streamdock.log:1018 is the exact line — yt-dlp retried it and succeeded.
  it('an error line yt-dlp retried does not survive a successful exit', async () => {
    const engine = newEngine();
    const { id } = startVideo(engine, YOUTUBE);
    const child = childFor(YOUTUBE);
    child.out(
      '[download] Got error: Failed to perform, curl: (28) Connection timed out after 20010 milliseconds. See https://curl.se/libcurl/c/libcurl-errors.html first for more details.. Retrying (1/3)...',
      '[download] 100% of   10.00MiB in 00:00:10 at 1.00MiB/s',
    );
    child.exit(0);
    await settle(10);

    expect(find(engine, id).status).toBe('completed');
    expect(find(engine, id).error).toBeUndefined();
  });

  it('a retried error line does not raise a download-error event', async () => {
    const engine = newEngine();
    startVideo(engine, YOUTUBE);
    childFor(YOUTUBE).out(
      '[download] Got error: Failed to perform, curl: (56) Recv failure: Connection was reset. Retrying (1/3)...',
    );
    await settle(10);
    expect(sent.filter((e) => e.channel.includes('error'))).toHaveLength(0);
  });

  // Pause/cancel while "Extracting stream manifest…": no process exists yet, so
  // the task was never removed — a permanently occupied slot, a Resume that does
  // nothing, and a window close that always hides to the tray.
  it('pausing while the manifest is resolving frees the slot', async () => {
    const engine = newEngine();
    const { id } = startVideo(engine, episode(1));
    engine.pause(id);
    await settle();
    expect(find(engine, id).status).toBe('paused');
    expect(engine.activeCount()).toBe(0);
  });

  it('a job paused while resolving can be resumed', async () => {
    const engine = newEngine();
    const { id } = startVideo(engine, episode(1));
    engine.pause(id);
    await settle();
    engine.resume(id);
    await settle();
    expect(extractions).toHaveLength(2);
  });

  it('cancelling while the manifest is resolving frees the slot', async () => {
    const engine = newEngine();
    const { id } = startVideo(engine, episode(1));
    engine.cancel(id);
    await settle();
    expect(engine.activeCount()).toBe(0);
  });

  // resume()/retry() only check the global limit, so the probe-host rule that
  // enqueue() enforces is bypassed.
  it.fails('resume respects the one-at-a-time rule for probe hosts', async () => {
    const engine = newEngine();
    const a = startVideo(engine, episode(1));
    startVideo(engine, episode(2));
    extractions[0].resolve({ originalUrl: episode(1), manifestUrl: CDN(1), type: 'm3u8' });
    await settle();
    engine.pause(a.id); // frees the slot, so episode 2 starts resolving
    await settle();
    expect(extractions).toHaveLength(2);

    engine.resume(a.id);
    await settle();
    expect(running(engine)).toHaveLength(1);
  });

  // drainQueue() tests the rewritten CDN URL, so a resolved probe-host job stops
  // counting as one and a second episode can start beside it.
  it.fails('a finishing download elsewhere does not start a second probe-host job', async () => {
    const engine = newEngine();
    startVideo(engine, episode(1));
    extractions[0].resolve({ originalUrl: episode(1), manifestUrl: CDN(1), type: 'm3u8' });
    await settle();
    startVideo(engine, YOUTUBE);
    await settle();
    const second = startVideo(engine, episode(2));
    await settle();
    expect(find(engine, second.id).status).toBe('queued');

    childFor(YOUTUBE).exit(0);
    await settle();
    expect(find(engine, second.id).status).toBe('queued');
  });

  // Scheduled jobs are persisted as 'queued' and their timers are lost, so a
  // restart starts them immediately. main.ts calls setMaxConcurrent at boot.
  it.fails('a scheduled job does not start early after a restart', async () => {
    const first = newEngine();
    const at = new Date(Date.now() + 3_600_000).toISOString();
    startVideo(first, YOUTUBE, { scheduledAt: at });
    first.shutdown();

    const second = newEngine();
    second.setMaxConcurrent(3);
    await settle();
    expect(children).toHaveLength(0);
  });

  // Ep 553: DNS failed mid-download, yt-dlp skipped fragments, moved a 59MB
  // file into the folder, then exited 1. The file stayed; with --no-overwrites a
  // retry would then report it "Already saved".
  it('a failed download leaves no file it had already moved into the folder', async () => {
    const engine = newEngine();
    const { id } = startVideo(engine, YOUTUBE);
    const final = join(outputDir, 'Episode 553.mp4');
    writeFileSync(final, 'truncated');
    const child = childFor(YOUTUBE);
    child.out(
      '[download] fragment not found; Skipping fragment 344 ...',
      `[MoveFiles] Moving file "${join(outputDir, '.streamdock-incomplete', id, 'x.mp4')}" to "${final}"`,
      'ERROR: fragment 1 not found, unable to continue',
    );
    child.exit(1);
    await settle(10);

    expect(find(engine, id).status).toBe('failed');
    expect(existsSync(final)).toBe(false);
  });

  it('a VOD download aborts on missing fragments instead of skipping them', async () => {
    const engine = newEngine();
    startVideo(engine, YOUTUBE);
    expect(childFor(YOUTUBE).args).toContain('--abort-on-unavailable-fragments');
  });

  // Remove on a finished row was renderer-only: the engine kept the record and
  // it came back on the next launch.
  it('removing a finished download deletes it from the engine and from disk state', async () => {
    const engine = newEngine();
    const { id } = startVideo(engine, YOUTUBE);
    childFor(YOUTUBE).exit(0);
    await settle(10);

    engine.remove(id);
    expect(engine.list().map((r) => r.id)).not.toContain(id);
    expect(readFileSync(join(userDataDir, 'downloads-state.json'), 'utf-8')).not.toContain(id);
  });

  // History is kept until the user clears it (Decision 4); a silent 24h prune
  // removed finished rows on the next unrelated completion.
  it.fails('finished downloads are kept until cleared', async () => {
    const engine = newEngine();
    const old = startVideo(engine, `${YOUTUBE}&old=1`);
    childFor(`${YOUTUBE}&old=1`).exit(0);
    await settle();

    vi.setSystemTime(Date.now() + 25 * 3_600_000);
    startVideo(engine, YOUTUBE);
    childFor(YOUTUBE).exit(0);
    await settle(10);
    expect(engine.list().map((r) => r.id)).toContain(old.id);
  });
});

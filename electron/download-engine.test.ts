// DownloadEngine behaviour, driven through a fake yt-dlp process and a fake
// manifest extractor. The engine is otherwise real: state-store, url-router,
// error classification and argument building all run as shipped.
//
// Every defect found in the session-22 audit was first recorded here as an
// `it.fails` test stating the correct behaviour, and flipped to `it` by the
// change that fixed it — so each of these once failed against the real bug.
import { EventEmitter } from 'events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import log from 'electron-log';

let userDataDir = mkdtempSync(join(tmpdir(), 'streamdock-engine-'));
/** Whether the fake internet answers the engine's reachability check. */
let internetUp = true;

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? userDataDir : join(userDataDir, 'downloads')),
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
  net: {
    request: () => {
      const req = new EventEmitter() as EventEmitter & { end: () => void };
      req.end = () => queueMicrotask(() => (internetUp ? req.emit('response', {}) : req.emit('error', new Error('offline'))));
      return req;
    },
  },
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

  /** yt-dlp prints warnings and errors on stderr. */
  err(...lines: string[]): void {
    this.stderr.emit('data', Buffer.from(lines.map((l) => `${l}\n`).join('')));
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

type ManifestResult = {
  originalUrl: string;
  manifestUrl: string;
  type: string;
  referer?: string;
  languageOutcome?: 'selected' | 'absent' | 'unconfirmed';
  translation?: string;
  subtitles?: Array<{ url: string; referer?: string }>;
};
const extractions: Array<{ url: string; translation?: string; resolve: (r: ManifestResult | null) => void }> = [];

vi.mock('./manifest-extractor', () => ({
  extractManifest: vi.fn(
    (url: string, translation?: string, signal?: AbortSignal) =>
      new Promise<ManifestResult | null>((resolve) => {
        extractions.push({ url, translation, resolve });
        // Like the real extractor: an abort ends the extraction with nothing.
        signal?.addEventListener('abort', () => resolve(null));
      }),
  ),
}));

// ── Fake subtitle delivery ───────────────────────────────────────────────────

const attached: Array<{ video: string; tracks: unknown[]; mode: string; done: () => void }> = [];

vi.mock('./subtitle-attach', () => ({
  attachSubtitles: vi.fn(
    (video: string, tracks: unknown[], mode: string) =>
      new Promise<number>((resolve) => attached.push({ video, tracks, mode, done: () => resolve(tracks.length) })),
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
/** Holding a slot: resolving a manifest or running yt-dlp. */
const active = (engine: Engine) => engine.list().filter((r) => r.status === 'running' || r.status === 'resolving');
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
  attached.length = 0;
  sent = [];
  internetUp = true;
  vi.mocked(log.error).mockClear();
});

afterEach(() => {
  // transition() refuses and logs a move the lifecycle does not allow. No
  // scenario here may attempt one.
  const illegal = vi.mocked(log.error).mock.calls.filter(([m]) => String(m).includes('illegal transition'));
  expect(illegal).toEqual([]);
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
  it('resume respects the one-at-a-time rule for probe hosts', async () => {
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
    expect(active(engine)).toHaveLength(1);
    expect(find(engine, a.id).status).toBe('queued');
  });

  // drainQueue() tests the rewritten CDN URL, so a resolved probe-host job stops
  // counting as one and a second episode can start beside it.
  it('a finishing download elsewhere does not start a second probe-host job', async () => {
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
  it('a scheduled job does not start early after a restart', async () => {
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
  it('finished downloads are kept until cleared', async () => {
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

// ── Phase 2: one lifecycle, one scheduler ────────────────────────────────────

const DNS_FAILURE =
  'ERROR: [download] Got error: Failed to perform, curl: (6) Could not resolve host: f0ja7.zhaevor.top. Giving up after 10 retries';

describe('network loss', () => {
  // streamdock.log 2026-09-26 00:18-00:30: DNS died mid-run and the queue
  // started and failed ~45 remaining episodes, each "Something went wrong".
  it('holds a job and the queue while the internet is unreachable, then carries on', async () => {
    const engine = newEngine();
    engine.setMaxConcurrent(1);
    const a = startVideo(engine, YOUTUBE);
    const b = startVideo(engine, `${YOUTUBE}&n=2`);
    internetUp = false;
    childFor(YOUTUBE).err(DNS_FAILURE);
    childFor(YOUTUBE).exit(1);
    await settle(100);

    expect(find(engine, a.id).status).toBe('queued');
    expect(find(engine, a.id).error).toBeUndefined();
    expect(find(engine, a.id).waitReason).toMatch(/network/i);
    expect(find(engine, b.id).status).toBe('queued');
    expect(children).toHaveLength(1);

    internetUp = true;
    await settle(10_100);
    expect(find(engine, a.id).status).toBe('running');
    expect(children).toHaveLength(2);
  });

  it('fails a job whose site is unreachable while the internet is fine', async () => {
    const engine = newEngine();
    const { id } = startVideo(engine, YOUTUBE);
    childFor(YOUTUBE).err(DNS_FAILURE);
    childFor(YOUTUBE).exit(1);
    await settle(100);
    expect(find(engine, id).status).toBe('failed');
    expect(find(engine, id).error).toMatch(/could not reach the server/i);
  });
});

describe('language fidelity (Decision 2: an unproven Dub fails clearly)', () => {
  it('downloads the resolved stream when the requested language was proven', async () => {
    const engine = newEngine();
    const { id } = startVideo(engine, episode(1), { translation: 'dub' });
    expect(extractions[0].translation).toBe('dub');
    extractions[0].resolve({ originalUrl: episode(1), manifestUrl: CDN(1), type: 'm3u8', languageOutcome: 'selected', translation: 'dub' });
    await settle();
    expect(find(engine, id).status).toBe('running');
    expect(find(engine, id).resolvedTranslation).toBe('dub');
    expect(childFor(CDN(1))).toBeDefined();
  });

  it('retries once, then fails without downloading, when the language cannot be proven', async () => {
    const engine = newEngine();
    const { id } = startVideo(engine, episode(1), { translation: 'dub' });
    extractions[0].resolve({ originalUrl: episode(1), manifestUrl: CDN(1), type: 'm3u8', languageOutcome: 'unconfirmed' });
    await settle(10);
    expect(extractions).toHaveLength(2);
    extractions[1].resolve({ originalUrl: episode(1), manifestUrl: CDN(1), type: 'm3u8', languageOutcome: 'unconfirmed' });
    await settle(10);

    expect(find(engine, id).status).toBe('failed');
    expect(find(engine, id).error).toMatch(/could not confirm the dub stream/i);
    expect(children).toHaveLength(0);
  });

  it('fails at once when the page offers no such language', async () => {
    const engine = newEngine();
    const { id } = startVideo(engine, episode(1), { translation: 'dub' });
    extractions[0].resolve({ originalUrl: episode(1), manifestUrl: CDN(1), type: 'm3u8', languageOutcome: 'absent' });
    await settle(10);
    expect(extractions).toHaveLength(1);
    expect(find(engine, id).error).toMatch(/dub is not available/i);
    expect(children).toHaveLength(0);
  });
});

describe('subtitles the player loaded beside the stream (B7)', () => {
  const VTT = { url: 'https://cdn.example/subs/eng.vtt', referer: 'https://megaplay.buzz/' };

  async function finishEpisode(engine: Engine, extra: Record<string, unknown>) {
    const { id } = startVideo(engine, episode(1), extra);
    extractions[0].resolve({ originalUrl: episode(1), manifestUrl: CDN(1), type: 'm3u8', subtitles: [VTT] });
    await settle();
    const final = join(outputDir, 'One Piece - Episode 1.mp4');
    childFor(CDN(1)).out(`[MoveFiles] Moving file "${join(outputDir, '.streamdock-incomplete', id, 'x.mp4')}" to "${final}"`);
    childFor(CDN(1)).exit(0);
    await settle(10);
    return { id, final };
  }

  it('attaches them to the finished file before the row reads completed', async () => {
    const engine = newEngine();
    const { id, final } = await finishEpisode(engine, { subtitleMode: 'embed' });
    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatchObject({ video: final, tracks: [VTT], mode: 'embed' });
    expect(find(engine, id).status).toBe('running');

    attached[0].done();
    await settle(10);
    expect(find(engine, id).status).toBe('completed');
  });

  it('leaves them alone when this download\'s rule is "none"', async () => {
    const engine = newEngine();
    const { id } = await finishEpisode(engine, { subtitleMode: 'none' });
    expect(attached).toHaveLength(0);
    expect(find(engine, id).status).toBe('completed');
  });
});

describe('a manifest the picker found', () => {
  it('is resolved afresh on a probe host: its token dies in ~90s, and only the engine\'s own resolve catches subtitles', async () => {
    const engine = newEngine();
    startVideo(engine, episode(1), { manifestUrl: CDN(9), manifestReferer: 'https://megaplay.buzz/' });
    expect(extractions).toHaveLength(1);
    extractions[0].resolve({ originalUrl: episode(1), manifestUrl: CDN(1), type: 'm3u8' });
    await settle();
    expect(childFor(CDN(1))).toBeDefined();
  });

  it('is still used when the fresh resolve finds nothing', async () => {
    const engine = newEngine();
    const { id } = startVideo(engine, episode(1), { manifestUrl: CDN(9), translation: 'dub' });
    extractions[0].resolve(null);
    await settle(10);
    extractions[1].resolve(null);
    await settle();
    expect(childFor(CDN(9))).toBeDefined();
    expect(find(engine, id).status).toBe('running');
    expect(find(engine, id).resolvedTranslation).toBe('dub');
  });
});

describe('scheduler', () => {
  it('tells a waiting row why it is waiting', async () => {
    const engine = newEngine();
    startVideo(engine, episode(1));
    const second = startVideo(engine, episode(2));
    await settle(10);
    expect(find(engine, second.id).waitReason).toMatch(/anikoto\.cz allows 1 download at a time/);
  });

  it('shows the resolve phase as its own state, not as the title', async () => {
    const engine = newEngine();
    const { id } = startVideo(engine, episode(1), { displayTitle: 'One Piece - Episode 1' });
    expect(find(engine, id).status).toBe('resolving');
    expect(find(engine, id).title).toBe('One Piece - Episode 1');
  });

  it('writes the state file once for a burst of changes, not once per change', async () => {
    const { StateStore } = await import('./state-store');
    const save = vi.spyOn(StateStore.prototype, 'save');
    const engine = newEngine();
    for (let i = 0; i < 100; i++) startVideo(engine, `${YOUTUBE}&n=${i}`);
    await settle(600);
    expect(save.mock.calls.length).toBeLessThanOrEqual(2);
    save.mockRestore();
  });

  it('retry puts a failed download back in the queue and runs it', async () => {
    const engine = newEngine();
    const { id } = startVideo(engine, YOUTUBE);
    childFor(YOUTUBE).exit(1);
    await settle(100);
    expect(find(engine, id).status).toBe('failed');

    engine.retry(id);
    await settle();
    expect(find(engine, id).status).toBe('running');
    expect(find(engine, id).error).toBeUndefined();
    expect(children).toHaveLength(2);
  });
});

describe('restart', () => {
  it('brings back interrupted downloads as paused and sweeps staging nothing can resume', async () => {
    const first = newEngine();
    const running = startVideo(first, YOUTUBE);
    const resolving = startVideo(first, episode(1));
    await settle(600); // the debounced save lands; then the app "crashes"

    const staging = join(outputDir, '.streamdock-incomplete');
    mkdirSync(join(staging, running.id), { recursive: true });
    mkdirSync(join(staging, 'orphan-from-a-crash'), { recursive: true });

    const second = newEngine();
    expect(find(second, running.id).status).toBe('paused');
    expect(find(second, resolving.id).status).toBe('paused');
    expect(existsSync(join(staging, running.id))).toBe(true);
    expect(existsSync(join(staging, 'orphan-from-a-crash'))).toBe(false);
  });
});

describe('stalls', () => {
  // The old monitor paused ep 551 ten seconds after its first stall while
  // yt-dlp was still retrying, and never resumed it.
  it('reports a silent download on the row and never pauses it', async () => {
    const engine = newEngine();
    const { id } = startVideo(engine, YOUTUBE);
    childFor(YOUTUBE).out('[download]  10.0% of   300.00MiB at    1.00MiB/s ETA 05:00');
    await settle(36_000);
    expect(find(engine, id).status).toBe('running');
    expect(find(engine, id).stallMessage).toMatch(/no data/i);

    childFor(YOUTUBE).out('[download]  11.0% of   300.00MiB at    1.00MiB/s ETA 05:00');
    expect(find(engine, id).stallMessage).toBeUndefined();
  });
});

describe('remove', () => {
  it('removes an active download once its process has exited, and says so once', async () => {
    const engine = newEngine();
    const { id } = startVideo(engine, YOUTUBE);
    expect(engine.remove(id)).toBe(true);
    await settle(100);
    expect(engine.list().map((r) => r.id)).not.toContain(id);
    expect(sent.filter((e) => e.channel === 'event:download-removed')).toHaveLength(1);
  });
});

describe('events to the renderer', () => {
  it('coalesces a burst of progress lines, never delays a status change, and numbers every event', async () => {
    const engine = newEngine();
    const { id } = startVideo(engine, YOUTUBE);
    await settle(300);
    sent = [];
    for (let i = 1; i <= 20; i++) childFor(YOUTUBE).out(`[download]  ${i}.0% of   300.00MiB at    1.00MiB/s ETA 05:00`);
    const burst = sent.filter((e) => e.channel === 'event:download-progress').length;
    expect(burst).toBeLessThanOrEqual(1);

    engine.pause(id);
    expect(sent.at(-1)?.record.status).toBe('paused');

    await settle(300);
    const revisions = sent.filter((e) => e.record.id === id).map((e) => e.record.revision);
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
    expect(new Set(revisions).size).toBe(revisions.length);
  });
});

describe('log volume', () => {
  it('keeps yt-dlp messages in the log but not its progress ticks', async () => {
    vi.mocked(log.debug).mockClear();
    const engine = newEngine();
    startVideo(engine, YOUTUBE);
    childFor(YOUTUBE).out(
      '[download]  42.0% of   10.00MiB at    1.00MiB/s ETA 00:06',
      '[download] Got error: Failed to perform, curl: (28) Connection timed out. Retrying (1/10)...',
    );
    const logged = vi.mocked(log.debug).mock.calls.map(([m]) => String(m));
    expect(logged.some((m) => m.includes('42.0%'))).toBe(false);
    expect(logged.some((m) => m.includes('Retrying (1/10)'))).toBe(true);
  });
});

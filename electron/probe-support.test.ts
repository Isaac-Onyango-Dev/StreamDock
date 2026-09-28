// The plumbing every probe shares: a fetch and a child process that must always
// come back, and a hidden window that must leave nothing behind. Each test here
// was run against the code it replaced and failed there first.
import { EventEmitter } from 'events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const userDataDir = mkdtempSync(join(tmpdir(), 'streamdock-probe-'));

/** Requests made through the fake `net`; each is driven by the test. */
const requests: FakeRequest[] = [];
class FakeRequest extends EventEmitter {
  aborted = false;
  end = vi.fn();
  abort = vi.fn(() => { this.aborted = true; });
}

/** Sessions handed out by the fake `session.fromPartition`. */
const partitions: string[] = [];
const sessions: Array<ReturnType<typeof fakeSession>> = [];
function fakeSession() {
  return {
    webRequest: { onBeforeRequest: vi.fn(), onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() },
    clearCache: vi.fn(() => Promise.resolve()),
    clearStorageData: vi.fn(() => Promise.resolve()),
  };
}
const windows: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  net: {
    request: () => {
      const req = new FakeRequest();
      requests.push(req);
      return req;
    },
  },
  session: {
    fromPartition: (name: string) => {
      partitions.push(name);
      const s = fakeSession();
      sessions.push(s);
      return s;
    },
  },
  BrowserWindow: vi.fn().mockImplementation(() => {
    const win = {
      destroy: vi.fn(),
      webContents: { setAudioMuted: vi.fn(), setWindowOpenHandler: vi.fn(), setUserAgent: vi.fn() },
    };
    windows.push(win);
    return win;
  }),
}));

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill = vi.fn(() => true);
}
const children: FakeChild[] = [];
vi.mock('child_process', () => {
  const spawn = vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  const execFile = vi.fn((_command: string, _args: string[], _options: unknown, cb?: (err: unknown) => void) => {
    queueMicrotask(() => cb?.(null));
  });
  return { spawn, execFile, default: { spawn, execFile } };
});

const { execFile } = await import('child_process');
const {
  fetchWithDeadline,
  openHiddenProbe,
  runProbeChild,
  sweepProbeTempFiles,
} = await import('./probe-support');

const realPlatform = process.platform;

beforeEach(() => {
  requests.length = 0;
  children.length = 0;
  partitions.length = 0;
  sessions.length = 0;
  windows.length = 0;
  vi.mocked(execFile).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', { value: realPlatform });
});

describe('fetchWithDeadline', () => {
  it('comes back empty when the server never answers', async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = fetchWithDeadline('https://cdn.example/master.m3u8', { timeoutMs: 20_000 })
      .then((r) => { settled = true; return r; });

    await vi.advanceTimersByTimeAsync(20_000);

    expect(settled).toBe(true);
    expect((await pending).body).toBeNull();
    expect(requests[0].aborted).toBe(true);
  });

  it('comes back when the response dies mid-body, without waiting for the deadline', async () => {
    const pending = fetchWithDeadline('https://example.test/series', { timeoutMs: 60_000 });
    const response = Object.assign(new EventEmitter(), { headers: {}, statusCode: 200 });
    requests[0].emit('response', response);
    response.emit('data', Buffer.from('<html>'));
    response.emit('aborted');

    await expect(pending).resolves.toMatchObject({ body: null });
  });

  it('keeps multi-byte characters that straddle two chunks', async () => {
    const pending = fetchWithDeadline('https://example.test/', { timeoutMs: 1_000 });
    const response = Object.assign(new EventEmitter(), { headers: {}, statusCode: 200 });
    requests[0].emit('response', response);
    const bytes = Buffer.from('ワンピース', 'utf-8');
    response.emit('data', bytes.subarray(0, 4));
    response.emit('data', bytes.subarray(4));
    response.emit('end');

    await expect(pending).resolves.toMatchObject({ status: 200, body: 'ワンピース' });
  });
});

describe('runProbeChild', () => {
  it('kills the whole process tree on Windows when the deadline passes', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.useFakeTimers();
    const pending = runProbeChild('yt-dlp.exe', ['--dump-json', 'x'], { timeoutMs: 25_000 });

    await vi.advanceTimersByTimeAsync(25_000);

    await expect(pending).resolves.toMatchObject({ code: null });
    // yt-dlp.exe is a PyInstaller bootloader whose worker is a second process;
    // ending only the pid we spawned leaves that worker running.
    expect(execFile).toHaveBeenCalledWith('taskkill', ['/pid', '4242', '/T', '/F'], expect.anything(), expect.any(Function));
    expect(children[0].kill).not.toHaveBeenCalled();
  });

  it('rejects at once when aborted, and stops the child', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const controller = new AbortController();
    const pending = runProbeChild('yt-dlp.exe', ['x'], { timeoutMs: 60_000, signal: controller.signal });

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(execFile).toHaveBeenCalledWith('taskkill', ['/pid', '4242', '/T', '/F'], expect.anything(), expect.any(Function));
  });
});

describe('openHiddenProbe', () => {
  it('gives two probes started in the same millisecond separate sessions', () => {
    // A session holds one listener per webRequest event, so a shared one lets
    // the second probe replace the first one's interception.
    vi.useFakeTimers();
    const probes = [openHiddenProbe(), openHiddenProbe()];

    expect(partitions[0]).not.toBe(partitions[1]);
    for (const probe of probes) probe.dispose();
  });

  it('leaves no listener, cache, storage, window or preload behind', async () => {
    const probe = openHiddenProbe();
    probe.dispose();
    await Promise.resolve();
    await Promise.resolve();

    const s = sessions[0];
    expect(s.webRequest.onBeforeRequest).toHaveBeenCalledWith(null);
    expect(s.webRequest.onBeforeSendHeaders).toHaveBeenCalledWith(null);
    expect(s.webRequest.onHeadersReceived).toHaveBeenCalledWith(null);
    expect(s.clearCache).toHaveBeenCalled();
    expect(s.clearStorageData).toHaveBeenCalled();
    expect(windows[0].destroy).toHaveBeenCalled();
    expect(readdirSync(join(userDataDir, 'manifest-probe')).filter((n) => n.startsWith('spoof-'))).toEqual([]);
  });
});

describe('sweepProbeTempFiles', () => {
  it('removes leftover cookie jars and preloads, and nothing else', () => {
    const probeDir = join(userDataDir, 'manifest-probe');
    const legacyDir = join(userDataDir, 'stream-options-probe');
    mkdirSync(probeDir, { recursive: true });
    mkdirSync(legacyDir, { recursive: true });
    for (const name of ['cookies-1.txt', 'spoof-a.js', 'keep.txt']) writeFileSync(join(probeDir, name), 'x');
    writeFileSync(join(legacyDir, 'spoof-b.js'), 'x');

    sweepProbeTempFiles();

    expect(readdirSync(probeDir).sort()).toEqual(['keep.txt']);
    expect(existsSync(join(legacyDir, 'spoof-b.js'))).toBe(false);
  });
});

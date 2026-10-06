// Role: the plumbing every probe shares — a disposable hidden browser, a fetch
// and a child process that each carry a deadline and honour an AbortSignal,
// and the temp files those leave behind.
//
// manifest-extractor and stream-options-probe each carried their own copy of
// the user agent, the preload spoof, the manifest pattern, the window setup
// and the teardown, and three files had their own net.request helper — only
// one of which had a timeout. The copies had already drifted.

import { app, BrowserWindow, net, session } from 'electron';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import log from 'electron-log';

/**
 * Chrome-like user-agent to avoid headless detection.
 * Matches the user's real Chrome 148 on Windows.
 */
export const SPOOF_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

/**
 * Preload script injected into the BrowserWindow to spoof automation
 * detection properties that sites use to block headless browsers.
 */
const PRELOAD_SPOOF = `
// Override navigator properties that bots expose
Object.defineProperty(navigator, 'webdriver', { get: () => false });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
// Override chrome.runtime to look like a real extension is present
if (window.chrome) {
  Object.defineProperty(chrome, 'runtime', { get: () => ({}) });
}
`;

export type StreamType = 'm3u8' | 'mpd' | 'mp4';

/**
 * What kind of media a URL names, from its extension.
 *
 * `.mp4` is on the list because some hosts really do serve a progressive file,
 * but it is also what every video ad creative is. Callers treat it as a last
 * resort and never let it win over an HLS/DASH manifest.
 */
export function mediaTypeFromUrl(url: string): StreamType | null {
  const match = url.match(/\.(m3u8|mpd|mp4)(?:\?|$)/i);
  return match ? (match[1].toLowerCase() as StreamType) : null;
}

/**
 * A playlist's type from its Content-Type, for streams served at URLs with no
 * extension. Never 'mp4': an MSE player's fMP4 segments are video/mp4 too, and
 * taking one for the whole video would save a two-second clip.
 */
export function mediaTypeFromContentType(contentType: string | undefined): StreamType | null {
  const type = contentType?.split(';')[0].trim().toLowerCase();
  if (!type) return null;
  if (/^(?:application|audio)\/(?:x-|vnd\.apple\.)?mpegurl$/.test(type)) return 'm3u8';
  return type === 'application/dash+xml' ? 'mpd' : null;
}

/** Subtitle files a web player fetches beside the stream. */
export const SUBTITLE_PATTERN = /\.(vtt|srt|ass)(?:\?|$)/i;

/** Temp files (preload spoofs, cookie jars) live here and nowhere else. */
function probeDir(): string {
  const dir = join(app.getPath('userData'), 'manifest-probe');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export interface HiddenProbe {
  win: BrowserWindow;
  session: Electron.Session;
  /** Tear everything down. Safe to call more than once. */
  dispose: () => void;
}

/**
 * A hidden, muted, popup-proof browser window on a session of its own.
 *
 * The partition used to be `…-${Date.now()}`, so two probes started in the same
 * millisecond shared one session — and a session has exactly one listener per
 * webRequest event, so the second probe silently replaced the first one's
 * interception. It is a random UUID now.
 *
 * ponytail: Electron never frees a session once created, so each probe still
 * leaves one empty in-memory session behind; dispose() clears its cache and
 * storage and drops its listeners, which is what actually held memory. A small
 * pool of reused partitions is the upgrade if the husks ever show up.
 */
export function openHiddenProbe(): HiddenProbe {
  const probeSession = session.fromPartition(`probe-${randomUUID()}`, { cache: true });

  // Written to disk so it runs before any page script.
  const preloadPath = join(probeDir(), `spoof-${randomUUID()}.js`);
  writeFileSync(preloadPath, PRELOAD_SPOOF, 'utf-8');

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: {
      session: probeSession,
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.webContents.setAudioMuted(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.setUserAgent(SPOOF_UA);

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    // Detach first. The listeners were never removed, so each finished probe's
    // closures — and everything they captured — stayed reachable from its
    // session for the life of the app.
    try {
      probeSession.webRequest.onBeforeRequest(null);
      probeSession.webRequest.onBeforeSendHeaders(null);
      probeSession.webRequest.onHeadersReceived(null);
    } catch { /* session already torn down */ }
    try { win.destroy(); } catch { /* already gone */ }
    try { rmSync(preloadPath, { force: true }); } catch { /* swept at next start */ }
    // The partition's HTTP cache was never cleared, only its storage.
    Promise.resolve().then(() => probeSession.clearCache()).catch(() => { });
    Promise.resolve().then(() => probeSession.clearStorageData()).catch(() => { });
  };

  return { win, session: probeSession, dispose };
}

/**
 * Run a script in the page's main frame now.
 *
 * `webContents.executeJavaScript` is documented as "suspended until web page
 * stop loading", and a streaming page does not stop loading for a long time —
 * measured on anikoto: dom-ready at +1.4s, the server list rendered at +3.4s,
 * `did-stop-loading` only at +21.7s while ad and analytics requests trickled
 * in. The language click ran through it, so it could not even start until
 * +21.7s, and the gate's 12s bail gave up first: "selection timed out" on 8 of
 * 10 real Dub episodes. `mainFrame.executeJavaScript` carries no such
 * suspension and ran at +1.4s in the same measurement.
 */
export function runInPage<T = unknown>(win: BrowserWindow, code: string): Promise<T> {
  try {
    if (win.isDestroyed()) return Promise.reject(new Error('probe window is gone'));
    return win.webContents.mainFrame.executeJavaScript(code) as Promise<T>;
  } catch (err) {
    return Promise.reject(err);
  }
}

export interface FetchResult {
  /** HTTP status, or 0 when no response arrived. */
  status: number;
  body: string | null;
  /** Raw Set-Cookie header values from the response. */
  setCookies: string[];
}

export interface FetchOptions {
  headers?: Record<string, string>;
  /** Total budget for the whole exchange, not an idle timeout. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Stop keeping the body past this many bytes. */
  maxBytes?: number;
}

/**
 * GET a URL from the main process, and always come back.
 *
 * Resolves with `body: null` on any failure — a network error, a response that
 * errors or is aborted mid-body, the deadline, or the signal. Three helpers
 * used to do this job: one had a deadline, one had nothing at all (a server
 * that accepted the connection and never answered left the track picker
 * spinning forever), and one had only an idle timeout and no handler for a
 * response that died mid-body.
 */
export function fetchWithDeadline(url: string, options: FetchOptions): Promise<FetchResult> {
  const { headers = {}, timeoutMs, signal, maxBytes = Infinity } = options;
  const failed: FetchResult = { status: 0, body: null, setCookies: [] };

  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(failed);
      return;
    }
    let request: Electron.ClientRequest | undefined;
    let done = false;
    const settle = (result: FetchResult): void => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const cancel = (): void => {
      try { request?.abort(); } catch { /* already finished */ }
    };
    const onAbort = (): void => {
      cancel();
      settle(failed);
    };
    const deadline = setTimeout(() => {
      log.warn(`[probe] GET ${url} gave no answer within ${timeoutMs}ms`);
      cancel();
      settle(failed);
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      request = net.request({
        method: 'GET',
        url,
        headers: {
          'User-Agent': SPOOF_UA,
          'Accept-Language': 'en-US,en;q=0.9',
          ...headers,
        },
      });
      request.on('response', (response) => {
        const raw = response.headers['set-cookie'];
        const setCookies = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          if (size >= maxBytes) return;
          chunks.push(chunk);
          size += chunk.length;
        });
        // Decoded once at the end: decoding chunk by chunk splits multi-byte
        // characters that straddle a chunk boundary.
        response.on('end', () => settle({
          status: response.statusCode,
          body: size > 0 ? Buffer.concat(chunks).toString('utf-8') : null,
          setCookies,
        }));
        response.on('error', () => settle(failed));
        response.on('aborted', () => settle(failed));
      });
      request.on('error', () => settle(failed));
      request.end();
    } catch {
      settle(failed);
    }
  });
}

/**
 * Convert raw Set-Cookie header strings into a Netscape-format cookies.txt
 * that yt-dlp can consume via --cookies.
 */
function toNetscapeCookies(setCookies: string[], baseUrl: string): string {
  const lines = ['# Netscape HTTP Cookie File', '# Generated by StreamDock manifest-extractor'];
  try {
    const defaultDomain = new URL(baseUrl).hostname;
    for (const cookie of setCookies) {
      const [nameValue, ...attrs] = cookie.split(/;\s*/);
      const eqIdx = nameValue.indexOf('=');
      if (eqIdx === -1) continue;
      const name = nameValue.substring(0, eqIdx).trim();
      const value = nameValue.substring(eqIdx + 1).trim();
      let domain = defaultDomain;
      let path = '/';
      let secure = false;
      let expiry = 0;
      for (const attr of attrs) {
        const eqPos = attr.indexOf('=');
        const k = (eqPos !== -1 ? attr.substring(0, eqPos) : attr).trim().toLowerCase();
        const v = eqPos !== -1 ? attr.substring(eqPos + 1).trim() : '';
        if (k === 'domain' && v) domain = v;
        else if (k === 'path' && v) path = v;
        else if (k === 'secure') secure = true;
        else if (k === 'expires' && v) {
          const d = new Date(v);
          if (!isNaN(d.getTime())) expiry = Math.floor(d.getTime() / 1000);
        } else if (k === 'max-age' && v) {
          const maxAge = parseInt(v, 10);
          if (!isNaN(maxAge)) expiry = Math.floor(Date.now() / 1000) + maxAge;
        }
      }
      const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE';
      lines.push(`${domain}\t${flag}\t${path}\t${secure ? 'TRUE' : 'FALSE'}\t${expiry}\t${name}\t${value}`);
    }
  } catch { /* ignore malformed cookies */ }
  return lines.join('\n');
}

/**
 * Write the cookies a probe collected to a temp cookies.txt for yt-dlp.
 *
 * Whoever receives the path owns the file and must delete it; anything a crash
 * leaves behind is removed by sweepProbeTempFiles() at the next start.
 */
export function writeCookiesFile(setCookies: string[], baseUrl: string): string | undefined {
  if (setCookies.length === 0) return undefined;
  try {
    const cookiePath = join(probeDir(), `cookies-${randomUUID()}.txt`);
    writeFileSync(cookiePath, toNetscapeCookies(setCookies, baseUrl), 'utf-8');
    log.info(`[probe] Wrote ${setCookies.length} cookie(s) → ${cookiePath}`);
    return cookiePath;
  } catch (err) {
    log.warn('[probe] Could not write cookies file:', err);
    return undefined;
  }
}

/** Delete a temp file a probe handed out. Best-effort by design. */
export function removeTempFile(path: string | undefined): void {
  if (!path) return;
  try { rmSync(path, { force: true }); } catch { /* swept at next start */ }
}

/**
 * Delete every cookies-*.txt and spoof-*.js a probe left behind.
 *
 * Both leaked: a pause or cancel during extraction, the engine's ceiling and
 * every probeMediaTracks call left a cookie jar on disk, and a crash mid-probe
 * leaves its preload. Call it at startup, before any probe or download runs —
 * it cannot tell a leftover from a file in use. `stream-options-probe/` is
 * where that probe wrote its preloads before the two shared one directory.
 */
export function sweepProbeTempFiles(): void {
  const userData = app.getPath('userData');
  let removed = 0;
  for (const dir of [join(userData, 'manifest-probe'), join(userData, 'stream-options-probe')]) {
    if (!existsSync(dir)) continue;
    try {
      for (const name of readdirSync(dir)) {
        if (!/^(?:cookies-.+\.txt|spoof-.+\.js)$/.test(name)) continue;
        try {
          rmSync(join(dir, name), { force: true });
          removed++;
        } catch { /* locked; next start */ }
      }
    } catch (err) {
      log.debug(`[probe] Could not sweep ${dir}:`, err);
    }
  }
  if (removed > 0) log.info(`[probe] Swept ${removed} leftover probe temp file(s)`);
}

/**
 * Stop a probe child and everything it started.
 *
 * yt-dlp.exe is a PyInstaller one-file build: the process we spawn is a
 * bootloader, and the work happens in a second yt-dlp.exe it starts. Verified
 * on the bundled binary: after killing the spawned pid, its child was still
 * running. `child.kill()` on Windows ends only the pid it holds, so every
 * probe timeout left a worker behind with its network connections open. The
 * download engine already kills the tree this way. On POSIX the bootloader
 * forwards SIGTERM to its child.
 */
export function killProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (process.platform === 'win32' && pid !== undefined) {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, (err) => {
      if (err) {
        log.warn(`[probe] taskkill failed for pid ${pid}: ${err.message}`);
        try { child.kill(); } catch { /* already gone */ }
      }
    });
    return;
  }
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
}

export interface ChildResult {
  /** Exit code, or null when the child failed to start, ran out of time or overflowed. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ChildOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Kill the child once stdout passes this many bytes. */
  maxBytes?: number;
}

/** Enough stderr to explain a failure; a chatty probe must not hold megabytes of it. */
const STDERR_CAP = 64 * 1024;

/**
 * Run a probe command with a deadline, killing its whole tree on timeout.
 *
 * Resolves on exit, timeout or overflow (with `code: null` for the last two);
 * rejects with the signal's reason if aborted. `probeViaYtDlp` had no timeout
 * at all and was never killed, and the other two probes killed only the pid
 * they held.
 */
export function runProbeChild(command: string, args: string[], options: ChildOptions): Promise<ChildResult> {
  const { timeoutMs, signal, maxBytes = Infinity } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const child = spawn(command, args, { windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;

    const collected = (code: number | null): ChildResult => ({
      code,
      stdout: Buffer.concat(out).toString('utf-8'),
      stderr: Buffer.concat(err).toString('utf-8'),
    });
    const end = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = (): void => {
      killProcessTree(child);
      end(() => reject(signal?.reason));
    };
    const timer = setTimeout(() => {
      log.warn(`[probe] ${basename(command)} ran past ${timeoutMs}ms; stopping it`);
      killProcessTree(child);
      end(() => resolve(collected(null)));
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxBytes) {
        killProcessTree(child);
        end(() => resolve(collected(null)));
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errBytes >= STDERR_CAP) return;
      err.push(chunk);
      errBytes += chunk.length;
    });
    child.on('error', () => end(() => resolve(collected(null))));
    child.on('close', (code) => end(() => resolve(collected(code))));
  });
}

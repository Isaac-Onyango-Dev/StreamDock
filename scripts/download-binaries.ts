// Role: fetches the real yt-dlp/ffmpeg/ffprobe binaries StreamDock bundles.
//
// Previously this script only printed instructions and created an empty
// binaries/ directory — nothing ever actually downloaded anything. Since
// binaries/ is gitignored and no CI workflow called this script, every
// packaged build (including the published v1.1.0 release) shipped with an
// empty resources/binaries/ folder: engines showed "not loaded" and
// "Update Engines" failed for every user who didn't happen to have yt-dlp/
// ffmpeg on their system PATH already.
//
// It was then Windows-only, and returned early on every other platform with a
// message. That left the same bug latent for Linux: CI's Build Linux job ran
// this script, got a clean exit and no binaries, and packaged an AppImage with
// an empty resources/binaries/ — a "successful" build of an app that cannot
// download anything. `npm run check:binaries` now exists so that cannot pass
// silently again.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';

const BINARIES_DIR = join(import.meta.dirname, '..', 'binaries');

/**
 * Where each platform's engines come from.
 *
 * yt-dlp publishes a self-contained executable per platform; note `yt-dlp`
 * (no suffix) is deliberately NOT used — it is the small zipimport build that
 * requires a system Python, which a bundled app cannot assume.
 *
 * ffmpeg comes from BtbN, pinned to the `latest` *tag* rather than
 * `releases/latest/`. These are different things, and conflating them broke the
 * Windows build: `releases/latest/download/...` resolves to whatever GitHub
 * currently calls the newest release, and BtbN also publishes dated autobuilds
 * (`autobuild-2026-09-07-15-39`) whose assets carry versioned names like
 * `ffmpeg-N-126455-gecc7eb519e-win64-gpl.zip`. The instant one of those is
 * published the stable `ffmpeg-master-latest-*` name 404s — the same commit
 * succeeded before an autobuild and failed after it. The `latest` tag is the
 * rolling release BtbN maintains specifically to carry the stable filenames.
 */
interface PlatformSpec {
  /** Asset name on the yt-dlp release. */
  ytDlpAsset: string;
  /** BtbN archive name, or null where BtbN publishes no build for the platform. */
  ffmpegArchive: string | null;
  /** Suffix on the installed executables ('.exe' on Windows, '' elsewhere). */
  exeSuffix: string;
}

const PLATFORMS: Record<string, PlatformSpec> = {
  'win32-x64': {
    ytDlpAsset: 'yt-dlp.exe',
    ffmpegArchive: 'ffmpeg-master-latest-win64-gpl.zip',
    exeSuffix: '.exe',
  },
  'linux-x64': {
    ytDlpAsset: 'yt-dlp_linux',
    ffmpegArchive: 'ffmpeg-master-latest-linux64-gpl.tar.xz',
    exeSuffix: '',
  },
  'linux-arm64': {
    ytDlpAsset: 'yt-dlp_linux_aarch64',
    ffmpegArchive: 'ffmpeg-master-latest-linuxarm64-gpl.tar.xz',
    exeSuffix: '',
  },
  // BtbN publishes no macOS build, so ffmpeg cannot be automated here from the
  // same source. macOS is not a distributed target; this entry exists so local
  // development on a Mac still gets a working yt-dlp.
  'darwin-x64': { ytDlpAsset: 'yt-dlp_macos', ffmpegArchive: null, exeSuffix: '' },
  'darwin-arm64': { ytDlpAsset: 'yt-dlp_macos', ffmpegArchive: null, exeSuffix: '' },
};

const platformKey = `${process.platform}-${process.arch}`;
const spec = PLATFORMS[platformKey];

const YT_DLP_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const FFMPEG_BASE = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest';

/**
 * Fetch with retry.
 *
 * This step pulls ~150MB from two external hosts and had no resilience
 * whatsoever: a single 429 or 5xx aborted the whole packaged build. That is
 * exactly what happened on CI — the step failed in 3 seconds, far too fast to
 * be a transfer problem, on a commit whose diff did not touch this file.
 *
 * A release build is the worst place to be one flaky response away from
 * failure, so transient statuses and network errors are retried with backoff.
 * A 404 is not retried: that means the asset name is wrong, and hammering it
 * just delays a real error.
 */
const MAX_ATTEMPTS = 4;

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function download(url: string): Promise<Buffer> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow' });

      if (response.ok) return Buffer.from(await response.arrayBuffer());

      if (!isRetryableStatus(response.status)) {
        throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
      }
      lastError = new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
    } catch (error) {
      // A non-retryable status is rethrown above as a plain Error; anything
      // reaching here from fetch itself is a network-level failure worth a retry.
      if (error instanceof Error && /Download failed \((?:4\d\d)/.test(error.message) && !/\((?:408|429)/.test(error.message)) {
        throw error;
      }
      lastError = error;
    }

    if (attempt < MAX_ATTEMPTS) {
      const delayMs = 2_000 * 2 ** (attempt - 1);
      const reason = lastError instanceof Error ? lastError.message : String(lastError);
      console.warn(`[binaries] attempt ${attempt}/${MAX_ATTEMPTS} failed (${reason}); retrying in ${delayMs / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(
    `Download failed after ${MAX_ATTEMPTS} attempts: ${url}\n` +
    `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/** Mark a downloaded file executable. A no-op on Windows, essential everywhere else. */
function makeExecutable(path: string): void {
  if (process.platform === 'win32') return;
  chmodSync(path, 0o755);
}

/**
 * yt-dlp ships roughly monthly and sites break extractors continuously, so a
 * "present" binary is not automatically a usable one.
 *
 * This used to return early whenever the binary existed. On CI that was
 * harmless (the runner starts clean and always fetched the latest), but on a
 * developer machine it meant the binary downloaded once was reused forever:
 * this repo shipped a 2026.03.17 yt-dlp that 403'd on every YouTube download
 * while the current release worked with the exact same arguments. Refresh
 * anything older than the staleness threshold instead.
 */
const MAX_ENGINE_AGE_DAYS = 30;

function ytDlpAgeDays(exePath: string): number | null {
  try {
    const raw = execFileSync(exePath, ['--version'], { encoding: 'utf-8', windowsHide: true });
    const match = raw.trim().match(/^(\d{4})\.(\d{2})\.(\d{2})/);
    if (!match) return null;
    const released = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Math.floor((Date.now() - released) / 86_400_000);
  } catch {
    // Unrunnable binary (corrupt, wrong arch, not executable, blocked by AV) —
    // treat as needing a fresh copy rather than silently keeping something that
    // cannot execute.
    return null;
  }
}

async function ensureYtDlp(): Promise<void> {
  const name = `yt-dlp${spec.exeSuffix}`;
  const target = join(BINARIES_DIR, name);

  if (existsSync(target)) {
    const ageDays = ytDlpAgeDays(target);
    if (ageDays !== null && ageDays < MAX_ENGINE_AGE_DAYS) {
      console.log(`[binaries] ${name} is ${ageDays} days old, keeping it`);
      return;
    }
    console.log(
      ageDays === null
        ? `[binaries] ${name} present but not runnable, replacing it`
        : `[binaries] ${name} is ${ageDays} days old, refreshing`,
    );
  }

  console.log(`[binaries] Downloading ${spec.ytDlpAsset} -> ${name}...`);
  writeFileSync(target, await download(`${YT_DLP_BASE}/${spec.ytDlpAsset}`));
  // Before the age check, not after: on Linux and macOS a freshly written file
  // is not executable, so `--version` would fail and report it unrunnable.
  makeExecutable(target);
  const newAge = ytDlpAgeDays(target);
  console.log(`[binaries] ${name} ready${newAge === null ? '' : ` (${newAge} days old)`}`);
}

/** Extract a BtbN archive. `.zip` on Windows, `.tar.xz` on Linux; both via tar. */
function extractArchive(archivePath: string, destDir: string): void {
  let tarCommand = 'tar';
  if (process.platform === 'win32') {
    // Explicit path to Windows' native bsdtar: a bare "tar" can resolve to Git
    // for Windows' GNU tar instead (when its bin dir precedes System32 on
    // PATH), which misparses a "C:\..." argument as a "host:path" remote-tar
    // spec and fails.
    const systemTar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (existsSync(systemTar)) tarCommand = systemTar;
  }
  // GNU tar and bsdtar both auto-detect the compression from the archive, so
  // one invocation covers .zip and .tar.xz.
  execFileSync(tarCommand, ['-xf', archivePath, '-C', destDir], { stdio: 'inherit' });
}

async function ensureFfmpeg(): Promise<void> {
  const ffmpegName = `ffmpeg${spec.exeSuffix}`;
  const ffprobeName = `ffprobe${spec.exeSuffix}`;
  const ffmpegTarget = join(BINARIES_DIR, ffmpegName);
  const ffprobeTarget = join(BINARIES_DIR, ffprobeName);

  if (existsSync(ffmpegTarget) && existsSync(ffprobeTarget)) {
    console.log(`[binaries] ${ffmpegName} / ${ffprobeName} already present, skipping download`);
    return;
  }

  if (!spec.ffmpegArchive) {
    console.warn(
      `[binaries] No automated ffmpeg source for ${platformKey}. ` +
      `Install ffmpeg and ffprobe into ${BINARIES_DIR} yourself (e.g. \`brew install ffmpeg\`, ` +
      `then copy the binaries in).`,
    );
    return;
  }

  console.log(`[binaries] Downloading ${spec.ffmpegArchive} (this is large, ~130MB)...`);
  const archiveBuffer = await download(`${FFMPEG_BASE}/${spec.ffmpegArchive}`);
  const archivePath = join(BINARIES_DIR, `_ffmpeg-download${spec.ffmpegArchive.endsWith('.zip') ? '.zip' : '.tar.xz'}`);
  const extractDir = join(BINARIES_DIR, '_ffmpeg-extract');
  writeFileSync(archivePath, archiveBuffer);

  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  console.log('[binaries] Extracting ffmpeg build...');
  extractArchive(archivePath, extractDir);

  // BtbN's archives extract to a single top-level folder containing
  // bin/ffmpeg[.exe] and bin/ffprobe[.exe] — same shape on Windows and Linux.
  const topLevel = readdirSync(extractDir)[0];
  const binDir = join(extractDir, topLevel, 'bin');
  copyFileSync(join(binDir, ffmpegName), ffmpegTarget);
  copyFileSync(join(binDir, ffprobeName), ffprobeTarget);
  makeExecutable(ffmpegTarget);
  makeExecutable(ffprobeTarget);

  rmSync(archivePath, { force: true });
  rmSync(extractDir, { recursive: true, force: true });
  console.log(`[binaries] ${ffmpegName} / ${ffprobeName} ready`);
}

async function main(): Promise<void> {
  mkdirSync(BINARIES_DIR, { recursive: true });

  if (!spec) {
    console.error(
      `[binaries] No engine sources are configured for ${platformKey}.\n` +
      `Supported: ${Object.keys(PLATFORMS).join(', ')}.\n` +
      `Place yt-dlp, ffmpeg and ffprobe into ${BINARIES_DIR} manually to develop here.`,
    );
    process.exit(1);
  }

  console.log(`[binaries] Platform: ${platformKey}`);
  await ensureYtDlp();
  await ensureFfmpeg();
  console.log('[binaries] All engine binaries ready in ./binaries');
}

main().catch((error) => {
  console.error('[binaries] Failed to prepare engine binaries:', error);
  process.exit(1);
});

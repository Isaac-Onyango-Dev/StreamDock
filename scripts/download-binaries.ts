// Role: fetches the real yt-dlp/ffmpeg/ffprobe binaries StreamDock bundles.
//
// Previously this script only printed instructions and created an empty
// binaries/ directory — nothing ever actually downloaded anything. Since
// binaries/ is gitignored and no CI workflow called this script, every
// packaged build (including the published v1.1.0 release) shipped with an
// empty resources/binaries/ folder: engines showed "not loaded" and
// "Update Engines" failed for every user who didn't happen to have yt-dlp/
// ffmpeg on their system PATH already.
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const BINARIES_DIR = join(import.meta.dirname, '..', 'binaries');

const YT_DLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const FFMPEG_ZIP_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip';

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * yt-dlp ships roughly monthly and sites break extractors continuously, so a
 * "present" binary is not automatically a usable one.
 *
 * This used to return early whenever yt-dlp.exe existed. On CI that was
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
    // Unrunnable binary (corrupt, wrong arch, blocked by AV) — treat as needing
    // a fresh copy rather than silently keeping something that cannot execute.
    return null;
  }
}

async function ensureYtDlp(): Promise<void> {
  const target = join(BINARIES_DIR, 'yt-dlp.exe');

  if (existsSync(target)) {
    const ageDays = ytDlpAgeDays(target);
    if (ageDays !== null && ageDays < MAX_ENGINE_AGE_DAYS) {
      console.log(`[binaries] yt-dlp.exe is ${ageDays} days old, keeping it`);
      return;
    }
    console.log(
      ageDays === null
        ? '[binaries] yt-dlp.exe present but not runnable, replacing it'
        : `[binaries] yt-dlp.exe is ${ageDays} days old, refreshing`,
    );
  }

  console.log('[binaries] Downloading yt-dlp.exe...');
  writeFileSync(target, await download(YT_DLP_URL));
  const newAge = ytDlpAgeDays(target);
  console.log(`[binaries] yt-dlp.exe ready${newAge === null ? '' : ` (${newAge} days old)`}`);
}

async function ensureFfmpeg(): Promise<void> {
  const ffmpegTarget = join(BINARIES_DIR, 'ffmpeg.exe');
  const ffprobeTarget = join(BINARIES_DIR, 'ffprobe.exe');
  if (existsSync(ffmpegTarget) && existsSync(ffprobeTarget)) {
    console.log('[binaries] ffmpeg.exe / ffprobe.exe already present, skipping download');
    return;
  }

  console.log('[binaries] Downloading ffmpeg build (this is large, ~100MB)...');
  const zipBuffer = await download(FFMPEG_ZIP_URL);
  const zipPath = join(BINARIES_DIR, '_ffmpeg-download.zip');
  const extractDir = join(BINARIES_DIR, '_ffmpeg-extract');
  writeFileSync(zipPath, zipBuffer);

  mkdirSync(extractDir, { recursive: true });
  console.log('[binaries] Extracting ffmpeg build...');
  // Explicit path to Windows' native bsdtar: a bare "tar" can resolve to Git for
  // Windows' GNU tar instead (e.g. when its bin dir precedes System32 on PATH),
  // which misparses a "C:\..." argument as a "host:path" remote-tar spec and fails.
  const systemTar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const tarCommand = existsSync(systemTar) ? systemTar : 'tar';
  execFileSync(tarCommand, ['-xf', zipPath, '-C', extractDir], { stdio: 'inherit' });

  // BtbN's archive extracts to a single top-level folder containing bin/ffmpeg.exe + bin/ffprobe.exe.
  const { readdirSync, copyFileSync } = await import('fs');
  const topLevel = readdirSync(extractDir)[0];
  const binDir = join(extractDir, topLevel, 'bin');
  copyFileSync(join(binDir, 'ffmpeg.exe'), ffmpegTarget);
  copyFileSync(join(binDir, 'ffprobe.exe'), ffprobeTarget);

  rmSync(zipPath, { force: true });
  rmSync(extractDir, { recursive: true, force: true });
  console.log('[binaries] ffmpeg.exe / ffprobe.exe ready');
}

async function main(): Promise<void> {
  mkdirSync(BINARIES_DIR, { recursive: true });

  if (process.platform !== 'win32') {
    console.log(
      [
        'StreamDock only ships packaged Windows builds today (macOS/Linux are',
        'not yet distributed), so this script only automates Windows binaries.',
        'For local dev on this platform, place the following yourself:',
        `  ${join(BINARIES_DIR, 'yt-dlp')}`,
        `  ${join(BINARIES_DIR, 'ffmpeg')}`,
        `  ${join(BINARIES_DIR, 'ffprobe')}`,
      ].join('\n'),
    );
    return;
  }

  await ensureYtDlp();
  await ensureFfmpeg();
  console.log('[binaries] All engine binaries ready in ./binaries');
}

main().catch((error) => {
  console.error('[binaries] Failed to prepare engine binaries:', error);
  process.exit(1);
});

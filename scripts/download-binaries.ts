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

async function ensureYtDlp(): Promise<void> {
  const target = join(BINARIES_DIR, 'yt-dlp.exe');
  if (existsSync(target)) {
    console.log('[binaries] yt-dlp.exe already present, skipping download');
    return;
  }
  console.log('[binaries] Downloading yt-dlp.exe...');
  writeFileSync(target, await download(YT_DLP_URL));
  console.log('[binaries] yt-dlp.exe ready');
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

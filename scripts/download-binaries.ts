// Role: optional helper for preparing local download engine binaries.
import { mkdir } from 'fs/promises';

await mkdir('binaries', { recursive: true });

console.log(
  [
    'StreamDock expects yt-dlp and ffmpeg in ./binaries or on PATH.',
    'Recommended filenames:',
    process.platform === 'win32' ? '  binaries/yt-dlp.exe' : '  binaries/yt-dlp',
    process.platform === 'win32' ? '  binaries/ffmpeg.exe' : '  binaries/ffmpeg',
  ].join('\n'),
);

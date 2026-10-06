import { defineConfig } from '@playwright/test';

/**
 * The real app, not a stubbed renderer: tests/electron drives the built
 * Electron app (`npm run build:app` first) with its real main process, yt-dlp
 * and ffmpeg, against a local media lab. It needs binaries/ and so is not part
 * of the CI E2E job; run it with `npm run test:electron`.
 */
export default defineConfig({
  testDir: './tests/electron',
  timeout: 180_000,
  workers: 1,
  reporter: 'list',
});

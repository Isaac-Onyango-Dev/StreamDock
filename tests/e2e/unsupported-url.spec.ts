import { test, expect } from '@playwright/test';

/**
 * A URL the probe found no route to can never be queued.
 *
 * The probe used to call such a page 'unknown' and show yt-dlp's raw
 * "Unsupported URL" as a note while the Download button stayed enabled; the
 * engine then queued it and failed it as unsupported. The verdict is now the
 * probe's, and the button, start() and the engine all obey it.
 */
const PAGE = 'https://videos.example/watch/clip-1?ep=1&lang=dub';
const REASON = 'This video stream is encrypted in a way only its own player can read, so it cannot be downloaded.';

type Calls = { started: unknown[]; tracks: number; streams: number };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ reason }) => {
    const calls = { started: [] as unknown[], tracks: 0, streams: 0 };
    const w = window as unknown as Record<string, unknown>;
    w.__calls = calls;
    const explicit: Record<string, unknown> = {
      getSettings: async () => ({ downloadDir: 'C:/Downloads', backgroundMode: 'gradient', maxConcurrent: 3 }),
      getEngineStatus: async () => [],
      listDownloads: async () => [],
      getPlatform: () => 'win32',
      getMenuLabels: async () => ['File', 'Edit', 'View', 'Help'],
      analyzeUrl: async (url: string) => ({
        success: true,
        data: { url, host: 'videos.example', valid: true, suggestedMode: 'video', reason: 'Standard media URL.', probesLanguages: false },
      }),
      inspectUrl: async (url: string) => ({
        success: true,
        data: {
          url,
          host: 'videos.example',
          title: 'This page cannot be downloaded',
          support: 'unsupported',
          blocked: 'encrypted',
          itemCount: 0,
          preview: [],
          isLive: false,
          notes: [reason],
        },
      }),
      probeMediaTracks: async () => { calls.tracks += 1; return { success: false, error: 'not in this test' }; },
      probeStreamOptions: async (pageUrl: string) => { calls.streams += 1; return { success: true, url: pageUrl, options: [] }; },
      startDownload: async (mode: string, request: unknown) => {
        calls.started.push({ mode, request });
        return {};
      },
    };
    w.streamDock = new Proxy(explicit, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        if (prop.startsWith('on')) return () => () => undefined;
        return async () => undefined;
      },
      has: () => true,
    });
  }, { reason: REASON });
  await page.goto('/');
  await page.waitForSelector('input[name="capture-url"]', { timeout: 15000 });
});

const calls = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as { __calls: Calls }).__calls);

test('Analyze shows why, and Download cannot be pressed', async ({ page }) => {
  await page.locator('input[name="capture-url"]').fill(PAGE);
  await page.getByRole('button', { name: 'Analyze' }).click();

  await expect(page.getByText(REASON)).toBeVisible();
  await expect(page.getByText('videos.example · Encrypted stream')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeDisabled();
  // Nothing to configure, so no hidden browser is opened for tracks or languages.
  expect(await calls(page)).toEqual({ started: [], tracks: 0, streams: 0 });
});

test('Download pressed without Analyze probes first, then refuses to queue', async ({ page }) => {
  await page.locator('input[name="capture-url"]').fill(PAGE);
  await page.getByRole('button', { name: 'Download', exact: true }).click();

  await expect(page.getByText(REASON).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeDisabled();
  expect((await calls(page)).started).toEqual([]);
});

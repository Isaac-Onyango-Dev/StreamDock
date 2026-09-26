import { test, expect } from '@playwright/test';

/**
 * Probe results belong to the URL they were started for.
 *
 * The language probe (dub/sub) runs in the background after Analyze and writes
 * its result into the plan when it finishes — without checking that the URL is
 * still the one being planned. Analyze episode A, paste episode B, let A's probe
 * land, press Download: B was queued with A's manifest, i.e. the wrong episode
 * under B's name.
 *
 * `test.fail` marks the known defect (session-22 audit); the fix flips it.
 */
const A = 'https://anikoto.cz/watch/show-a/ep-1';
const B = 'https://anikoto.cz/watch/show-b/ep-7';

type Started = { mode: string; request: { url: string; manifestUrl?: string } };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const pending: Record<string, (value: unknown) => void> = {};
    const started: unknown[] = [];
    const w = window as unknown as Record<string, unknown>;
    w.__started = started;
    w.__resolveStreamOptions = (pageUrl: string) =>
      pending[pageUrl]?.({
        success: true,
        url: pageUrl,
        options: [
          { manifestUrl: `${pageUrl}#sub-manifest`, language: 'Japanese', translation: 'sub', label: 'Sub' },
          { manifestUrl: `${pageUrl}#dub-manifest`, language: 'English', translation: 'dub', label: 'Dub' },
        ],
      });

    const explicit: Record<string, unknown> = {
      getSettings: async () => ({ downloadDir: 'C:/Downloads', backgroundMode: 'gradient', maxConcurrent: 3 }),
      getEngineStatus: async () => [],
      listDownloads: async () => [],
      getPlatform: () => 'win32',
      getMenuLabels: async () => ['File', 'Edit', 'View', 'Help'],
      analyzeUrl: async (url: string) => ({
        success: true,
        data: { url, host: 'anikoto.cz', valid: true, suggestedMode: 'video', reason: 'test' },
      }),
      inspectUrl: async (url: string) => ({
        success: true,
        data: {
          url,
          host: 'anikoto.cz',
          title: `Title of ${url}`,
          support: 'direct',
          itemCount: 1,
          preview: [{ id: '1', title: `Title of ${url}`, url }],
          isLive: false,
          notes: [],
        },
      }),
      probeMediaTracks: async () => ({ success: false, error: 'not in this test' }),
      probeStreamOptions: (pageUrl: string) => new Promise((resolve) => { pending[pageUrl] = resolve; }),
      startDownload: async (mode: string, request: unknown) => {
        started.push({ mode, request });
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
  });
  await page.goto('/');
  await page.waitForSelector('input[name="capture-url"]', { timeout: 15000 });
});

test.fail('a language probe for the previous URL never decides the next download', async ({ page }) => {
  const input = page.locator('input[name="capture-url"]');

  await input.fill(A);
  await page.getByRole('button', { name: 'Analyze' }).click();
  await expect(page.getByText(`Title of ${A}`).first()).toBeVisible();

  // Move on to episode B before A's language probe has answered…
  await input.fill(B);
  // …then A's answer arrives.
  await page.evaluate((url) => (window as unknown as { __resolveStreamOptions: (u: string) => void }).__resolveStreamOptions(url), A);
  await page.waitForTimeout(200);

  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { __started: unknown[] }).__started.length))
    .toBe(1);

  const [first] = await page.evaluate(() => (window as unknown as { __started: Started[] }).__started);
  expect(first.request.url).toBe(B);
  expect(first.request.manifestUrl ?? '').not.toContain('show-a');
});

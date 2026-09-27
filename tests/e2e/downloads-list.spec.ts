import { test, expect } from '@playwright/test';

/**
 * The Downloads list with a real-sized queue.
 *
 * It used a hand-rolled virtualiser that assumed 96px rows when real rows are
 * ~200px: the scroll height changed while scrolling, so rows jumped and the
 * scrollbar thumb resized under the pointer, and the layout switched mode at
 * the 21st item. Isaac saw it with a 53-episode queue.
 */
const COUNT = 120;
const STATUSES = ['running', 'queued', 'paused', 'completed', 'failed'] as const;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ count, statuses }) => {
    const records = Array.from({ length: count }, (_, i) => {
      const status = statuses[i % statuses.length];
      return {
        id: `job-${i}`,
        revision: 1,
        url: `https://anikoto.cz/watch/one-piece-odmau/ep-${549 + i}`,
        mode: 'video',
        title: `One Piece - Episode ${549 + i}`,
        status,
        progress: status === 'completed' ? 100 : 40,
        speed: status === 'running' ? '1.2MiB/s' : '',
        eta: '',
        createdAt: new Date(Date.UTC(2026, 8, 25, 23, 16, i)).toISOString(),
        priority: 100,
        bytesDownloaded: 0,
        bytesTotal: 0,
        // Failed rows are the tall ones: they carry an error and its details link.
        error: status === 'failed' ? 'Could not reach the server. Check your connection.' : undefined,
        errorDetail: status === 'failed' ? 'ERROR: curl: (6) Could not resolve host' : undefined,
        waitReason: status === 'queued' ? 'Waiting — anikoto.cz allows 1 download at a time' : undefined,
      };
    });
    const explicit: Record<string, unknown> = {
      getSettings: async () => ({ downloadDir: 'C:/Downloads', backgroundMode: 'gradient', maxConcurrent: 3 }),
      getEngineStatus: async () => [],
      listDownloads: async () => records,
      getPlatform: () => 'win32',
      getMenuLabels: async () => ['File', 'Edit', 'View', 'Help'],
    };
    (window as unknown as { streamDock: unknown }).streamDock = new Proxy(explicit, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        if (prop.startsWith('on')) return () => () => undefined;
        return async () => undefined;
      },
      has: () => true,
    });
  }, { count: COUNT, statuses: STATUSES });
  await page.setViewportSize({ width: 1240, height: 780 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Downloads' }).click();
  await expect(page.getByText(`${COUNT} items`)).toBeVisible();
});

test('keeps a constant scroll height while scrolling a long queue', async ({ page }) => {
  const list = page.locator('.downloads-scroll');
  const heights: number[] = [];
  for (const fraction of [0, 0.25, 0.5, 0.75, 1, 0.4, 0]) {
    await list.evaluate((el, f) => { el.scrollTop = (el.scrollHeight - el.clientHeight) * f; }, fraction);
    await page.waitForTimeout(60);
    heights.push(await list.evaluate((el) => el.scrollHeight));
  }
  // content-visibility sizes unrendered rows from an estimate until they have
  // rendered once, so the first pass may settle; after that it must not move.
  const settled = heights.slice(heights.indexOf(Math.max(...heights)));
  expect(new Set(settled.slice(1)).size).toBeLessThanOrEqual(1);
});

test('reaches the last download', async ({ page }) => {
  const list = page.locator('.downloads-scroll');
  await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(page.getByText(`One Piece - Episode ${549 + COUNT - 1}`)).toBeInViewport();
});

test('shows an error only on failed rows, and says why queued rows wait', async ({ page }) => {
  await expect(page.getByText('Could not reach the server. Check your connection.')).toHaveCount(COUNT / STATUSES.length);
  await expect(page.getByText('Waiting — anikoto.cz allows 1 download at a time').first()).toBeVisible();
});

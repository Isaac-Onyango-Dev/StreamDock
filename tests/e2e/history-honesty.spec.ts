import { test, expect } from '@playwright/test';

/**
 * Clear history, then Pause All, in the real UI.
 *
 * Isaac's report: purged rows came back after Pause All. The renderer cleared
 * every row locally — active ones included — while the engine cancelled
 * nothing, so the next progress event for each job (Pause All emits one per
 * job) put it back. A late event for a row the engine had deleted did the same.
 *
 * The page talks to a small fake engine that behaves like the real one: Clear
 * removes finished jobs only, Pause All emits an event per paused job, and it
 * also replays a stale event for a cleared row.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const base = { mode: 'video', speed: '', eta: '', priority: 100, bytesDownloaded: 0, bytesTotal: 0, createdAt: '2026-09-26T12:00:00Z' };
    const url = (n: number) => `https://anikoto.cz/watch/one-piece-odmau/ep-${n}`;
    const engine = new Map<string, Record<string, unknown>>([
      ['live', { ...base, id: 'live', revision: 3, url: url(549), title: 'Episode 549 (downloading)', status: 'running', progress: 40 }],
      ['done', { ...base, id: 'done', revision: 5, url: url(550), title: 'Episode 550 (finished)', status: 'completed', progress: 100 }],
      ['bad', { ...base, id: 'bad', revision: 4, url: url(551), title: 'Episode 551 (failed)', status: 'failed', progress: 20, error: 'Could not reach the server.' }],
    ]);
    const cleared = new Map<string, Record<string, unknown>>();
    const progress: Array<(r: unknown) => void> = [];

    const explicit: Record<string, unknown> = {
      getSettings: async () => ({ downloadDir: 'C:/Downloads', backgroundMode: 'gradient', maxConcurrent: 3 }),
      getEngineStatus: async () => [],
      getPlatform: () => 'win32',
      getMenuLabels: async () => ['File', 'Edit', 'View', 'Help'],
      listDownloads: async () => [...engine.values()],
      onDownloadProgress: (fn: (r: unknown) => void) => { progress.push(fn); return () => undefined; },
      clearEngineRecords: async () => {
        for (const [id, r] of engine) if (['completed', 'failed', 'cancelled'].includes(String(r.status))) { cleared.set(id, r); engine.delete(id); }
        return true;
      },
      stopAll: async () => {
        for (const r of engine.values()) {
          if (r.status !== 'running') continue;
          r.status = 'paused';
          r.revision = Number(r.revision) + 1;
          for (const fn of progress) fn({ ...r });
        }
        // A late event for a row the engine has already deleted.
        for (const r of cleared.values()) for (const fn of progress) fn({ ...r });
        return true;
      },
    };
    (window as unknown as { streamDock: unknown }).streamDock = new Proxy(explicit, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        if (prop.startsWith('on')) return () => () => undefined;
        return async () => undefined;
      },
      has: () => true,
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Downloads' }).click();
  await expect(page.getByText('Episode 550 (finished)')).toBeVisible();
});

test('Clear history removes only finished rows, and Pause All brings none back', async ({ page }) => {
  await page.getByRole('button', { name: 'Clear history' }).click();
  await expect(page.getByText('Episode 550 (finished)')).toHaveCount(0);
  await expect(page.getByText('Episode 551 (failed)')).toHaveCount(0);
  await expect(page.getByText('Episode 549 (downloading)')).toBeVisible();

  await page.getByRole('button', { name: 'Pause all' }).click();
  await expect(page.getByRole('button', { name: 'Resume all' })).toBeVisible();
  await expect(page.getByText('Episode 549 (downloading)')).toBeVisible();
  await expect(page.getByText('Episode 550 (finished)')).toHaveCount(0);
  await expect(page.getByText('Episode 551 (failed)')).toHaveCount(0);
});

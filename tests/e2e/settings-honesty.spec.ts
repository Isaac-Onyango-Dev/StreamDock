import { test, expect } from '@playwright/test';

/**
 * Settings that the app actually acts on.
 *
 * "Use Chrome cookies" was persisted and passed along with every download and
 * read by nothing (browser cookies were disabled long ago), and the one
 * behaviour users hit most — what closing the window does — had no setting at
 * all. Session 22 removed the first and added the second.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const saved: Array<Record<string, unknown>> = [];
    (window as unknown as { __saved: typeof saved }).__saved = saved;
    let settings: Record<string, unknown> = { downloadDir: 'C:/Downloads', backgroundMode: 'gradient', maxConcurrent: 3 };
    const explicit: Record<string, unknown> = {
      getSettings: async () => settings,
      updateSettings: async (updates: Record<string, unknown>) => {
        saved.push(updates);
        settings = { ...settings, ...updates };
        return settings;
      },
      getEngineStatus: async () => [],
      listDownloads: async () => [],
      getPlatform: () => 'win32',
      getMenuLabels: async () => ['File', 'Edit', 'View', 'Help'],
      pluginsList: async () => [{ name: 'anikoto', path: 'plugins/anikoto' }],
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
  await page.getByRole('button', { name: 'Settings' }).click();
});

test('offers no placebo cookies toggle', async ({ page }) => {
  await expect(page.getByText('Use Chrome cookies')).toHaveCount(0);
});

test('saves what closing the window should do', async ({ page }) => {
  const select = page.getByLabel('Closing the window while downloading');
  await expect(select).toHaveValue('tray-when-active');
  await select.selectOption('quit');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __saved: Array<Record<string, unknown>> }).__saved))
    .toContainEqual({ closeBehavior: 'quit' });
});

test('limits downloads at once to 5 and marks 3 as recommended', async ({ page }) => {
  const slider = page.getByRole('slider', { name: 'Concurrent downloads' });
  await expect(slider).toHaveAttribute('max', '5');
  await expect(slider).toHaveValue('3');
  await expect(page.getByText('3 (recommended)')).toBeVisible();
  await slider.fill('5');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __saved: Array<Record<string, unknown>> }).__saved))
    .toContainEqual({ maxConcurrent: 5 });
  await expect(page.getByText('3 (recommended)')).toHaveCount(0);
});

test('keeps separate subtitle rules for Sub and Dub', async ({ page }) => {
  await expect(page.getByLabel('Subtitles for Sub (original audio)')).toBeVisible();
  await expect(page.getByLabel('Subtitles for Dub')).toBeVisible();
});

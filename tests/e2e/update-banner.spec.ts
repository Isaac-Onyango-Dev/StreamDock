import { test, expect, type Page } from '@playwright/test';

/**
 * Drives the real UpdateBanner through every phase by stubbing only the preload
 * bridge, so the component, its styling and App's wiring are all the shipped
 * ones. Nothing here reaches Electron or the network.
 */
async function boot(page: Page) {
  await page.addInitScript(() => {
    type Listener = (payload: unknown) => void;
    const listeners: Listener[] = [];
    const w = window as unknown as Record<string, unknown>;
    w.__updateCalls = [] as string[];
    w.__emitUpdate = (state: unknown) => listeners.forEach((l) => l(state));
    w.streamDock = {
      getSettings: async () => ({ downloadDir: 'C:/tmp', backgroundMode: 'gradient' }),
      getEngineStatus: async () => [],
      updateSettings: async (u: unknown) => u,
      listDownloads: async () => [],
      getPlatform: () => 'win32',
      getUpdateState: async () => ({ phase: 'idle' }),
      onAppUpdateState: (cb: Listener) => {
        listeners.push(cb);
        return () => {};
      },
      checkForAppUpdate: async () => { (w.__updateCalls as string[]).push('check'); },
      downloadAppUpdate: async () => { (w.__updateCalls as string[]).push('download'); },
      installAppUpdate: async () => { (w.__updateCalls as string[]).push('install'); },
      dismissAppUpdate: async () => { (w.__updateCalls as string[]).push('dismiss'); },
      onMenuFocusTab: () => () => {},
      onMenuOpenDownloadFolder: () => () => {},
      onMenuPasteClipboard: () => () => {},
      onClipboardUrl: () => () => {},
      onEngineVersionWarning: () => () => {},
      onDownloadProgress: () => () => {},
      onDownloadComplete: () => () => {},
      onDownloadError: () => () => {},
      onWallpaperUpdated: () => () => {},
      onWindowFocused: () => () => {},
      onWindowBlurred: () => () => {},
      updateActiveCount: async () => {},
    };
  });
  await page.goto('/');
  await page.waitForSelector('text=Capture');
}

const emit = (page: Page, state: Record<string, unknown>) =>
  page.evaluate((s) => (window as never as { __emitUpdate: (x: unknown) => void }).__emitUpdate(s), state);

const banner = (page: Page) => page.locator('[data-update-phase]');

test('nothing is shown when idle', async ({ page }) => {
  await boot(page);
  await expect(banner(page)).toHaveCount(0);
});

test('a background check that fails or finds nothing stays invisible', async ({ page }) => {
  await boot(page);
  await emit(page, { phase: 'checking', interactive: false });
  await expect(banner(page)).toHaveCount(0);
  await emit(page, { phase: 'up-to-date', version: '1.7.0', interactive: false });
  await expect(banner(page)).toHaveCount(0);
  await emit(page, { phase: 'error', detail: 'getaddrinfo ENOTFOUND', interactive: false });
  await expect(banner(page)).toHaveCount(0);
});

test('an available update offers an in-app install and names both versions', async ({ page }) => {
  await boot(page);
  await emit(page, { phase: 'available', version: '1.8.0', currentVersion: '1.7.0', interactive: false });
  await expect(banner(page)).toHaveAttribute('data-update-phase', 'available');
  await expect(banner(page)).toContainText('StreamDock 1.8.0 is available.');
  await expect(banner(page)).toContainText('You are running 1.7.0.');
  await page.getByRole('button', { name: /Download & install/i }).click();
  expect(await page.evaluate(() => (window as never as { __updateCalls: string[] }).__updateCalls))
    .toContain('download');
});

test('a download in progress shows a moving bar, a percentage and bytes', async ({ page }) => {
  await boot(page);
  await emit(page, {
    phase: 'downloading', version: '1.8.0', percent: 0,
    transferred: 0, total: 302678424, interactive: true,
  });
  const bar = banner(page).locator('div.bg-accent').first();
  const width = async () => (await bar.boundingBox())!.width;

  await expect(banner(page)).toContainText('Downloading StreamDock 1.8.0…');
  const atZero = await width();

  await emit(page, {
    phase: 'downloading', version: '1.8.0', percent: 37.4,
    transferred: 113_200_000, total: 302678424, bytesPerSecond: 4_100_000, interactive: true,
  });
  await expect(banner(page)).toContainText('37%');
  await expect(banner(page)).toContainText('107.96 MB of 288.66 MB');
  await expect(banner(page)).toContainText('3.91 MB/s');
  const atThirtySeven = await width();

  await emit(page, {
    phase: 'downloading', version: '1.8.0', percent: 92,
    transferred: 278_000_000, total: 302678424, interactive: true,
  });
  const atNinetyTwo = await width();

  // The bar has to actually move, not just exist.
  expect(atZero).toBeLessThan(atThirtySeven);
  expect(atThirtySeven).toBeLessThan(atNinetyTwo);

  // And it must not be dismissible into invisibility mid-transfer by accident:
  // dismissing is allowed, but the control is a deliberate one.
  await expect(page.getByRole('button', { name: 'Dismiss update notice' })).toBeVisible();
});

test('a ready update offers the restart, and an installing one cannot be dismissed', async ({ page }) => {
  await boot(page);
  await emit(page, { phase: 'ready', version: '1.8.0', interactive: true });
  await expect(banner(page)).toContainText('ready to install');
  await expect(banner(page)).toContainText('resume afterwards');
  await page.getByRole('button', { name: /Restart & install/i }).click();
  expect(await page.evaluate(() => (window as never as { __updateCalls: string[] }).__updateCalls))
    .toContain('install');

  await emit(page, { phase: 'installing', version: '1.8.0', interactive: true });
  await expect(banner(page)).toContainText('Installing the update…');
  await expect(page.getByRole('button', { name: 'Dismiss update notice' })).toHaveCount(0);
});

test('a failure says what happened, where it is sending them, and never names GitHub', async ({ page }) => {
  await boot(page);
  await emit(page, {
    phase: 'error',
    detail: 'Could not download the update: net::ERR_CONNECTION_RESET',
    openedFallback: true,
    interactive: true,
    version: '1.8.0',
  });
  const text = (await banner(page).textContent()) ?? '';
  expect(text).toContain("Couldn't update automatically — opening the download page instead.");
  expect(text).toContain('ERR_CONNECTION_RESET');
  expect(text).toContain('https://isaac-onyango-dev.github.io/StreamDock/');
  expect(text).not.toContain('github.com');
  await expect(banner(page)).toHaveAttribute('role', 'alert');

  // Retry goes back to the download, because this failure already has a version.
  await page.getByRole('button', { name: /Try again/i }).click();
  expect(await page.evaluate(() => (window as never as { __updateCalls: string[] }).__updateCalls))
    .toContain('download');
});

test('a failed check retries the check, not the download', async ({ page }) => {
  await boot(page);
  await emit(page, { phase: 'error', detail: 'Could not check for updates: 503', interactive: true });
  await page.getByRole('button', { name: /Try again/i }).click();
  const calls = await page.evaluate(() => (window as never as { __updateCalls: string[] }).__updateCalls);
  expect(calls).toContain('check');
  expect(calls).not.toContain('download');
});

import { test, expect } from '@playwright/test';

/**
 * The clipboard watcher used to deliver its URL by assigning
 * `input.value` on the capture field and firing a synthetic `input` event.
 * The field is a *controlled* React input, and that assignment also updates
 * React's internal value tracker — so React saw no change, never ran onChange,
 * and re-rendered the field back to its (empty) state value. The captured URL
 * vanished and had to be pasted by hand.
 *
 * This drives the real bridge event and asserts the field actually holds the
 * URL afterwards, which is the part that was broken.
 */
const CAPTURED = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const SECOND = 'https://www.youtube.com/watch?v=wSm9GTUttBs';

test.describe('clipboard URL capture', () => {
  test.beforeEach(async ({ page }) => {
    // A bridge complete enough for the app to boot, with the clipboard event
    // exposed so the test can fire it the way the main process would.
    await page.addInitScript(() => {
      const listeners: Array<(payload: { url: string }) => void> = [];
      (window as unknown as { __emitClipboardUrl: (url: string) => void }).__emitClipboardUrl =
        (url: string) => listeners.forEach((fn) => fn({ url }));

      const explicit: Record<string, unknown> = {
        getSettings: async () => ({
          downloadDir: 'C:/Downloads',
          backgroundMode: 'gradient',
          maxConcurrent: 3,
        }),
        getEngineStatus: async () => [],
        listDownloads: async () => [],
        getPlatform: () => 'win32',
        getMenuLabels: async () => ['File', 'Edit', 'View', 'Help'],
        onClipboardUrl: (fn: (payload: { url: string }) => void) => {
          listeners.push(fn);
          return () => undefined;
        },
      };

      // Anything else the app reaches for gets a safe default, so this test
      // does not have to be updated every time the preload bridge grows a
      // method: `on*` returns an unsubscribe function, everything else a
      // resolved promise.
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
    await page.waitForSelector('input[name="capture-url"]', { timeout: 15000 });
  });

  test('a captured URL lands in the capture field, not just the placeholder', async ({ page }) => {
    const input = page.locator('input[name="capture-url"]');
    await expect(input).toHaveValue('');

    await page.evaluate((url) => {
      (window as unknown as { __emitClipboardUrl: (u: string) => void }).__emitClipboardUrl(url);
    }, CAPTURED);

    await expect(input).toHaveValue(CAPTURED);

    // The value must survive the next React render, which is where the old
    // DOM-poke version lost it: a controlled input re-renders to its state
    // value, and that state was never updated. Focusing the field flips
    // `inputFocused`, forcing exactly that render.
    await input.focus();
    await expect(input).toHaveValue(CAPTURED);

    // And it must be real React state, not just DOM text: the Analyze button
    // is enabled off the same state the input renders from.
    await expect(page.locator('button:has-text("Analyze")')).toBeEnabled();
  });

  test('capturing the same URL twice still delivers the second time', async ({ page }) => {
    const input = page.locator('input[name="capture-url"]');

    await page.evaluate((url) => {
      (window as unknown as { __emitClipboardUrl: (u: string) => void }).__emitClipboardUrl(url);
    }, CAPTURED);
    await expect(input).toHaveValue(CAPTURED);

    // Type over it, then re-copy the same URL: a plain string prop would
    // compare equal to the previous delivery and never re-fire.
    await input.fill(SECOND);
    await expect(input).toHaveValue(SECOND);

    await page.evaluate((url) => {
      (window as unknown as { __emitClipboardUrl: (u: string) => void }).__emitClipboardUrl(url);
    }, CAPTURED);
    await input.focus();
    await expect(input).toHaveValue(CAPTURED);
  });
});

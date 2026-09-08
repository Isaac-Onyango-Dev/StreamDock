import { test, expect } from '@playwright/test';

/**
 * These assert the rendered outcome rather than the source, so a regression is
 * caught wherever it comes from — the same reason titlebar.spec.ts exists.
 */
test.describe('quality picker', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-bg-mode]', { timeout: 10000 });
  });

  test('offers no invented resolutions before a source has been analyzed', async ({ page }) => {
    // The defect: with nothing detected the picker fell back to a hardcoded
    // 1080/720/480/360 ladder, so a user could pick 1080p for a source that
    // tops out at 480p. Nothing has been probed here, so nothing but the two
    // source-independent entries may appear.
    const options = await page.locator('select[name="download-quality"] option').allTextContents();
    const labels = options.map((text) => text.trim());

    expect(labels).toContain('Best quality');
    for (const fabricated of ['1080p', '720p', '480p', '360p', 'up to 1080p', 'up to 720p']) {
      expect(labels).not.toContain(fabricated);
    }
  });

  test('labels an explicit pick as a ceiling, never an exact demand', async ({ page }) => {
    // Every offered resolution is built as height<=N, so an item lacking that
    // resolution is downgraded rather than skipped. The label has to say so or
    // the downgrade reads as a silent failure.
    const values = await page
      .locator('select[name="download-quality"] option')
      .evaluateAll((nodes) => nodes.map((n) => (n as HTMLOptionElement).value));

    for (const value of values) {
      if (value === '' || value === 'bestaudio/best') continue;
      expect(value).toContain('height<=');
    }
  });
});

// The subtitle picker sits behind a probe, so it is not reachable in a network-free
// e2e run. A permanently-skipped test reads as coverage it does not provide, so the
// assertion that all four behaviours are offered lives in verify-engine instead.

import { test, expect } from '@playwright/test';

/**
 * The title bar has now been reported twice as showing "StreamDock" twice.
 *
 * The original cause was not markup: buildAppMenu() added a macOS-convention
 * app-name menu on every platform, and the in-window MenuBar rendered that
 * fifth top-level entry as a plain "StreamDock" label immediately before File,
 * Edit, View and Help — next to the gradient wordmark. It is macOS-only now.
 *
 * This asserts the rendered outcome rather than the cause, so any future
 * regression is caught wherever the second copy comes from.
 */
test.describe('title bar branding', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-bg-mode]', { timeout: 15000 });
  });

  test('the wordmark appears exactly once', async ({ page }) => {
    const header = page.locator('header').first();
    await expect(header).toBeVisible();

    expect((await header.innerText()).replace(/\s+/g, '')).toBe('StreamDock');

    const matches = (await header.innerText()).match(/StreamDock/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  test('the wordmark is the gradient one', async ({ page }) => {
    // "Dock" is painted by clipping the brand gradient to the text, so a
    // missing --brand-grad token would render it invisible rather than wrong.
    const style = await page.evaluate(() => {
      const el = document.querySelector('header span span');
      if (!el) return null;
      const computed = getComputedStyle(el);
      return { text: el.textContent, image: computed.backgroundImage, clip: computed.backgroundClip };
    });
    expect(style).not.toBeNull();
    expect(style!.text).toBe('Dock');
    expect(style!.image).toContain('linear-gradient');
    expect(style!.clip).toBe('text');
  });
});

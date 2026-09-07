import { test, expect } from '@playwright/test';

test.describe('StreamDock App', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for app to load
    await page.waitForSelector('[data-bg-mode]', { timeout: 10000 });
  });

  test('loads without errors', async ({ page }) => {
    // Check that the main app container exists
    await expect(page.locator('.contents')).toBeVisible();

    // Check that AppChrome nav rail is rendered (icon buttons with aria-labels)
    await expect(page.locator('[aria-label="Capture"]')).toBeVisible();
    await expect(page.locator('[aria-label="Downloads"]')).toBeVisible();
    await expect(page.locator('[aria-label="Settings"]')).toBeVisible();
  });

  test('can switch tabs', async ({ page }) => {
    // Click Downloads tab via aria-label
    await page.click('[aria-label="Downloads"]');
    await expect(page.locator('text=No downloads yet')).toBeVisible();

    // Click Settings tab
    await page.click('[aria-label="Settings"]');
    // Target the card heading by role: a bare `text=Save location` also matched
    // the Settings page description ("Save location, engine binaries, and
    // preferences."), which is a strict-mode violation, not a missing element.
    await expect(page.getByRole('heading', { name: 'Save location' })).toBeVisible();

    // Click back to Capture
    await page.click('[aria-label="Capture"]');
    await expect(page.locator('input[name="capture-url"]')).toBeVisible();
  });

  test('Capture view has URL input and analyze button', async ({ page }) => {
    await expect(page.locator('input[name="capture-url"]')).toBeVisible();
    await expect(page.locator('button:has-text("Analyze")')).toBeVisible();
    await expect(page.locator('button:has-text("Download")')).toBeVisible();
  });

  test('Settings view shows engine status', async ({ page }) => {
    await page.click('[aria-label="Settings"]');
    // Also role-based: `text=Engines` substring-matches the status badge
    // ("Engines ready") as well as this heading whenever engines are detected.
    await expect(page.getByRole('heading', { name: 'Engines' })).toBeVisible();
    await expect(page.locator('button:has-text("Update yt-dlp")')).toBeVisible();
  });
});
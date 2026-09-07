import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
  },
  /*
   * Renderer-only. There was a second project here using `channel: 'electron'`,
   * which is not a real Playwright channel — `channel` selects a Chromium build
   * (chrome, msedge, ...), and Electron is driven by a separate `_electron.launch()`
   * API instead. Every test in that project failed with
   *   browserType.launch: Unsupported chromium channel "electron"
   * and it duplicated the chromium project's specs besides. Removed rather than
   * left failing: these specs load the renderer over HTTP and assert on the DOM,
   * so they are browser tests, and pretending otherwise hid that real Electron
   * coverage does not exist yet. Adding it means _electron.launch() against the
   * packaged main process, in its own spec file.
   */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Vite alone: `npm run dev` also spawns the Electron main process, which
    // these tests never talk to and which has no display on a CI runner.
    command: 'npx vite --host 127.0.0.1',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
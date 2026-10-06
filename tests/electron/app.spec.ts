import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { frameHash, startLab, type Lab } from './fixtures/lab';

/**
 * The whole path in the real app: the real window, main process, hidden probe
 * browser, yt-dlp and ffmpeg, against pages served by a local lab. A download
 * passes only when the file decodes to the same frames the lab served.
 *
 * The app runs on a throwaway profile (`--user-data-dir`), so nothing here can
 * touch a real install's settings or download history.
 */
const repo = process.cwd();
const ffmpeg = join(repo, 'binaries', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

let lab: Lab;
let app: ElectronApplication;
let page: Page;
let downloads: string;
let profile: string;
let sourceHash: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.skip(!existsSync(join(repo, 'dist-electron', 'main.cjs')), 'run `npm run build:app` first');
  const work = mkdtempSync(join(tmpdir(), 'streamdock-app-'));
  profile = join(work, 'profile');
  downloads = join(work, 'downloads');
  mkdirSync(profile);
  mkdirSync(downloads);
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({
    downloadDir: downloads, clipboardWatcher: false, closeBehavior: 'quit', trayHintShown: true,
  }));
  lab = await startLab(join(tmpdir(), 'streamdock-lab-media'), ffmpeg);
  sourceHash = (await frameHash(ffmpeg, lab.source)).hash;
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: repo });
  page = await app.firstWindow();
  await page.waitForSelector('input[name="capture-url"]');
});

test.afterAll(async () => {
  await app?.close();
  await lab?.close();
});

/** Paste a URL and press Analyze, as a user would; resolves once the verdict is shown. */
async function analyze(url: string): Promise<void> {
  await page.getByRole('button', { name: 'Capture' }).click();
  await page.locator('input[name="capture-url"]').fill(url);
  await page.getByRole('button', { name: 'Analyze' }).click();
  await expect(page.getByText(/^127\.0\.0\.1 · /)).toBeVisible({ timeout: 90_000 });
}

const verdict = () => page.getByText(/^127\.0\.0\.1 · /).innerText();
const downloadButton = () => page.getByRole('button', { name: 'Download', exact: true });
const probesOf = (url: string) =>
  (readFileSync(join(profile, 'streamdock.log'), 'utf-8').match(/\[manifest-extractor\] Probing (\S+)/g) ?? [])
    .filter((line) => line.endsWith(url)).length;

/** Press Download and wait for the row named `title` to finish; returns the saved file. */
async function download(title: string): Promise<string> {
  await expect(downloadButton()).toBeEnabled();
  await downloadButton().click();
  await page.getByRole('button', { name: 'Downloads' }).click();
  const row = page.locator('article', { hasText: title });
  await expect(row.getByText(/^(Completed|Failed)$/)).toBeVisible({ timeout: 120_000 });
  await expect(row.getByText('Completed'), `"${title}" did not complete`).toBeVisible();
  return join(downloads, `${title}.mp4`);
}

async function expectSameFrames(file: string): Promise<void> {
  expect(existsSync(file), `${file} was not saved`).toBe(true);
  const got = await frameHash(ffmpeg, file);
  expect(got.frames).toBe(250);
  expect(got.hash).toBe(sourceHash);
}

test('a player in a cross-origin iframe on an unlisted site downloads, frame for frame', async () => {
  const url = `${lab.page}/iframe-gated.html`;
  await analyze(url);
  expect(await verdict()).toBe('127.0.0.1 · Stream probe');
  await expect(page.getByText('Embedded player page').first()).toBeVisible();
  // The CDN serves only its own player; this passes only if the referer the
  // hidden browser captured reaches yt-dlp.
  await expectSameFrames(await download('Embedded player page'));
});

test('one Analyze opens the page in one hidden browser, not two', async () => {
  const url = `${lab.page}/js-hls.html`;
  await analyze(url);
  // The track probe runs after the verdict; give it time to open its own.
  await page.waitForTimeout(8_000);
  expect(probesOf(url)).toBe(1);
});

test('a playlist served from a URL with no extension is found by its content type', async () => {
  await analyze(`${lab.page}/extless.html`);
  expect(await verdict()).toBe('127.0.0.1 · Stream probe');
  await expectSameFrames(await download('Extensionless player page'));
});

test('a cookie the player set reaches the download', async () => {
  await analyze(`${lab.page}/iframe-cookie.html`);
  expect(await verdict()).toBe('127.0.0.1 · Stream probe');
  await expectSameFrames(await download('Cookie player page'));
});

// The rest of the lab's downloadable shapes, each checked frame for frame.
// yt-dlp names an HTML5 page's video itself, "(1)" included.
for (const [path, label, title] of [
  ['/media/source.mp4', 'Single file', 'source'],
  ['/html5.html', 'Single file', 'HTML5 video page (1)'],
  ['/dash.html', 'Stream probe', 'DASH player page'],
  ['/redirect.html', 'Stream probe', 'Redirect player page'],
  ['/aes.html', 'Stream probe', 'AES player page'],
] as const) {
  test(`downloads ${path} (${label}) frame for frame`, async () => {
    await analyze(`${path.startsWith('/media/') ? lab.cdn : lab.page}${path}`);
    expect(await verdict()).toBe(`127.0.0.1 · ${label}`);
    await expectSameFrames(await download(title));
  });
}

test('a web page served as video/mp4 fails, and does not claim a restart', async () => {
  await analyze(`${lab.cdn}/fake.mp4`);
  await downloadButton().click();
  await page.getByRole('button', { name: 'Downloads' }).click();
  const row = page.locator('article', { hasText: 'fake' });
  await expect(row.getByText('Failed', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(row.getByText('What the server sent is not a valid video file, so the download failed.')).toBeVisible();
});

test('an encrypted stream is refused before anything is queued', async () => {
  await analyze(`${lab.page}/opaque.html`);
  expect(await verdict()).toBe('127.0.0.1 · Encrypted stream');
  await expect(downloadButton()).toBeDisabled();
  await expect(page.getByText(/encrypted in a way only its own player can read/)).toBeVisible();
});

test('a DRM-protected stream is refused and names the DRM', async () => {
  await analyze(`${lab.page}/drm-hls.html`);
  expect(await verdict()).toBe('127.0.0.1 · DRM-protected');
  await expect(downloadButton()).toBeDisabled();
  await expect(page.getByText(/protected by FairPlay DRM/)).toBeVisible();
});

test('DRM declared in a DASH manifest is refused too', async () => {
  await analyze(`${lab.page}/drm-dash.html`);
  expect(await verdict()).toBe('127.0.0.1 · DRM-protected');
  await expect(downloadButton()).toBeDisabled();
  await expect(page.getByText(/protected by Widevine DRM/)).toBeVisible();
});

test('a page with no video says no video was found, not that the site is unsupported', async () => {
  await analyze(`${lab.page}/novideo.html`);
  expect(await verdict()).toBe('127.0.0.1 · No video found');
  await expect(downloadButton()).toBeDisabled();
  await expect(page.getByText(/not supported/)).toHaveCount(0);
});

test('nothing refused above was ever queued', async () => {
  await page.getByRole('button', { name: 'Downloads' }).click();
  for (const title of ['Opaque player page', 'DRM HLS page', 'DRM DASH page', 'Text only']) {
    await expect(page.locator('article', { hasText: title })).toHaveCount(0);
  }
});

test('an invalid URL is rejected before any probe runs', async () => {
  await page.getByRole('button', { name: 'Capture' }).click();
  const input = page.locator('input[name="capture-url"]');
  // The field is type="url": the window itself refuses to submit text that is
  // not a URL, with its own hint, so Analyze never reaches the app.
  await input.fill('not a url');
  expect(await input.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(false);
  // A well-formed URL with another scheme gets past the field; the app refuses it.
  await input.fill('ftp://127.0.0.1/clip.mp4');
  await page.getByRole('button', { name: 'Analyze' }).click();
  await expect(page.getByText('Only http and https URLs are supported.')).toBeVisible();
});

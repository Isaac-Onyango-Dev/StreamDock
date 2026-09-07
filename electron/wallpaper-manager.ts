import { app, BrowserWindow, net } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import log from 'electron-log';
import { IPC } from './ipc-channels';
import { persistence } from './persistence';

let timerRef: ReturnType<typeof setInterval> | null = null;
let mainWindowRef: BrowserWindow | null = null;
let CACHE_DIR = '';

function readWallpaperSettings(): WallpaperSettings {
  const settings = persistence.getSettings();
  return {
    enabled: settings.backgroundMode === 'bing' || settings.backgroundMode === 'picsum',
    intervalMinutes: settings.bingRefreshInterval || 1440,
    source: settings.backgroundMode === 'bing' ? 'bing' : 'picsum',
  };
}

interface WallpaperSettings {
  enabled: boolean;
  intervalMinutes: number;
  source: 'bing' | 'picsum';
}

/**
 * Delete cached picsum-*.jpg files other than the one just written.
 * Without this, every rotation (default: every 24h) leaves its previous
 * image on disk forever — an unbounded cache that grows for as long as
 * picsum mode stays enabled. Bing mode doesn't need this: it always
 * (re)writes the same fixed 'bing-daily.jpg' filename.
 */
async function cleanupOldWallpapers(keepFilename: string): Promise<void> {
  try {
    const files = await fs.readdir(CACHE_DIR);
    await Promise.all(
      files
        .filter((f) => f.startsWith('picsum-') && f !== keepFilename)
        .map((f) => fs.unlink(path.join(CACHE_DIR, f)).catch(() => { /* best-effort */ })),
    );
  } catch (err) {
    log.warn('[wallpaper-manager] Could not clean up old wallpapers:', err);
  }
}

async function fetchNextWallpaper(settings: WallpaperSettings): Promise<string> {
  try {
    if (settings.source === 'bing') {
      const response = await net.fetch('https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=en-US');
      const data = await response.json() as { images?: Array<{ url?: string }> };
      const imageUrl = data?.images?.[0]?.url;
      if (!imageUrl) throw new Error('No image URL in Bing response');

      const fullUrl = `https://www.bing.com${imageUrl}`;
      const filename = 'bing-daily.jpg';
      const filePath = path.join(CACHE_DIR, filename);

      const imgResponse = await net.fetch(fullUrl);
      const buffer = await imgResponse.arrayBuffer();
      await fs.writeFile(filePath, Buffer.from(buffer));

      return filePath;
    } else {
      const response = await net.fetch('https://picsum.photos/1920/1080');
      const buffer = await response.arrayBuffer();
      const filename = `picsum-${Date.now()}.jpg`;
      const filePath = path.join(CACHE_DIR, filename);
      await fs.writeFile(filePath, Buffer.from(buffer));
      await cleanupOldWallpapers(filename);
      return filePath;
    }
  } catch (err) {
    log.error('[wallpaper-manager] Failed to fetch wallpaper:', err);
    throw err;
  }
}

function rotateTo(localFilePath: string): void {
  if (!mainWindowRef) return;
  const filename = path.basename(localFilePath);
  mainWindowRef.webContents.send(
    IPC.EVENT_WALLPAPER_UPDATED,
    `wallpaper://${filename}`
  );
}

async function getInitialWallpaper(): Promise<string | null> {
  const settings = readWallpaperSettings();
  if (!settings.enabled) return null;

  // Check disk cache before attempting any URL construction
  const cachedFiles = await fs.readdir(CACHE_DIR).catch(() => []);
  if (cachedFiles.length === 0) {
    // No cached wallpaper yet — fetch one now, don't try to
    // load a file:// URL for a file that doesn't exist
    return await fetchNextWallpaper(settings);
  }

  // fs.readdir() order is filesystem-dependent, not chronological — taking index 0
  // does not reliably give the most recently written file. Stat each candidate and
  // pick the one with the newest mtime instead.
  const withMtime = await Promise.all(
    cachedFiles.map(async (f) => {
      const full = path.join(CACHE_DIR, f);
      const mtimeMs = await fs.stat(full).then((s) => s.mtimeMs).catch(() => 0);
      return { full, mtimeMs };
    }),
  );
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withMtime[0].full;
}

export function initWallpaperManager(win: BrowserWindow): void {
  mainWindowRef = win;
  // Initialize CACHE_DIR here — app.getPath() is only safe after app.whenReady()
  CACHE_DIR = path.join(app.getPath('userData'), 'wallpapers');
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
  getInitialWallpaper().then((localPath) => {
    if (localPath) rotateTo(localPath);
    scheduleNextTick();
  }).catch((err) => {
    log.error('[wallpaper-manager] getInitialWallpaper failed:', err);
    scheduleNextTick();
  });
}

export function stopWallpaperManager(): void {
  if (timerRef !== null) {
    clearInterval(timerRef);
    timerRef = null;
  }
}

function scheduleNextTick(): void {
  stopWallpaperManager();
  
  const settings = readWallpaperSettings();
  if (!settings.enabled) return;
  
  const val = settings.intervalMinutes;
  const ms = Math.max(60_000, Number(val) * 60_000);
  if (!isFinite(ms)) return;

  timerRef = setInterval(async () => {
    try {
      await rotateTo(await fetchNextWallpaper(settings));
    } catch (err) {
      log.error('[wallpaper-manager] rotate cycle failed:', err);
    }
  }, ms);
}

export async function rotateNow(): Promise<string | null> {
  const settings = readWallpaperSettings();
  try {
    const localFilePath = await fetchNextWallpaper(settings);
    rotateTo(localFilePath);
    return `wallpaper://${path.basename(localFilePath)}`;
  } catch (err) {
    log.error('[wallpaper-manager] rotateNow failed:', err);
    return null;
  }
}

export function onSettingsChanged(): void {
  scheduleNextTick();
}

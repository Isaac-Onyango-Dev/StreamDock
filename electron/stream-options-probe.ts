// Role: discover language-specific manifest URLs by interacting with DOM language switchers
// and intercepting the resulting network requests (Approach C from AI discussion).

import { app, BrowserWindow, session } from 'electron';
import log from 'electron-log';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

export interface StreamOption {
  label: string;
  manifestUrl: string;
  manifestType: 'm3u8' | 'mpd' | 'mp4';
  referer?: string;
  isDefault: boolean;
}

export interface StreamOptionsProbeResult {
  success: boolean;
  url: string;
  options: StreamOption[];
  defaultOption?: StreamOption;
  error?: string;
}

const MANIFEST_PATTERN = /\.(m3u8|mpd|mp4)(\?|$)/i;

const LANGUAGE_SELECTOR_QUERIES = [
  // Common patterns across anime sites
  '[class*="language"] [class*="item"]',
  '[class*="dub"] button, [class*="sub"] button',
  '[data-type="dub"], [data-type="sub"]',
  '.server-item, .source-item',
  'select[name*="language"] option',
  '[class*="audio"] [class*="option"]',
  '[class*="lang"] button, [class*="lang"] [class*="item"]',
  '.language-option, .lang-option',

  // anikoto.cz specific selectors
  '.server-list .server-item',
  '.player-server-list .server-item',
  '[class*="server"] [class*="item"]',
  '.episode-servers .server',
  '[data-server]',
  '.server-option',
  '[class*="quality"] [class*="item"]',
];

const SPOOF_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const PRELOAD_SPOOF = `
Object.defineProperty(navigator, 'webdriver', { get: () => false });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
if (window.chrome) {
  Object.defineProperty(chrome, 'runtime', { get: () => ({}) });
}
`;

const EXTRACTION_TIMEOUT_MS = 60_000;
const POST_LOAD_WAIT_MS = 3000;

function mediaTypeFromUrl(url: string): 'm3u8' | 'mpd' | 'mp4' | null {
  const match = url.match(/\.(m3u8|mpd|mp4)(?:\?|$)/i);
  return match ? match[1].toLowerCase() as 'm3u8' | 'mpd' | 'mp4' : null;
}

function normalizeLanguageLabel(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('dub') && lower.includes('en')) return 'English Dub';
  if (lower.includes('sub') && lower.includes('en')) return 'English Sub';
  if (lower.includes('raw') || lower.includes('jp')) return 'Japanese Raw';
  if (lower.includes('dub')) return raw.replace(/dub/gi, 'Dub').trim();
  if (lower.includes('sub')) return raw.replace(/sub/gi, 'Sub').trim();
  
  // Common server/quality patterns on anime sites
  if (lower.includes('mega') || lower.includes('cloud')) return 'MegaCloud';
  if (lower.includes('stream') && lower.includes('tape')) return 'StreamTape';
  if (lower.includes('filemoon')) return 'FileMoon';
  if (lower.includes('vizcloud')) return 'VizCloud';
  if (lower.includes('cinewave')) return 'CineWave';
  if (lower.includes('gogo') || lower.includes('anix')) return 'GogoCDN';
  if (lower.includes('hd') || lower.includes('1080') || lower.includes('720')) return raw.trim();
  
  return raw.trim() || 'Unknown';
}

function inferLabelFromManifestUrl(manifestUrl: string, index: number): string {
  const lower = manifestUrl.toLowerCase();
  if (lower.includes('dub') && lower.includes('en')) return 'English Dub';
  if (lower.includes('sub') && lower.includes('en')) return 'English Sub';
  if (lower.includes('raw') || lower.includes('jp') || lower.includes('japanese')) return 'Japanese Raw';
  if (lower.includes('dub')) return 'Dub';
  if (lower.includes('sub')) return 'Sub';
  if (lower.includes('mega') || lower.includes('cloud')) return 'MegaCloud';
  if (lower.includes('streamtape')) return 'StreamTape';
  if (lower.includes('filemoon')) return 'FileMoon';
  if (lower.includes('vizcloud')) return 'VizCloud';
  if (lower.includes('cinewave')) return 'CineWave';
  if (lower.includes('gogo') || lower.includes('anix')) return 'GogoCDN';
  return `Stream ${index + 1}`;
}

async function waitForPlayer(win: BrowserWindow): Promise<boolean> {
  return win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const check = () => {
        const playerReady = 
          document.querySelector('video') !== null ||
          window.jwplayer !== undefined ||
          window.videojs !== undefined ||
          window.Hls !== undefined;

        if (playerReady) return resolve(true);
        setTimeout(check, 300);
      };
      check();
      setTimeout(() => resolve(false), 10000);
    })
  `);
}

async function discoverLanguageOptions(win: BrowserWindow): Promise<Array<{ query: string; index: number; text: string; value: string | null; isActive: boolean }>> {
  try {
    const options = await win.webContents.executeJavaScript(`
      (() => {
        const queries = ${JSON.stringify(LANGUAGE_SELECTOR_QUERIES)};
        const found = [];

        for (const query of queries) {
          try {
            const elements = document.querySelectorAll(query);
            elements.forEach((el, i) => {
              found.push({
                query,
                index: i,
                text: el.textContent?.trim() || '',
                value: el.value || el.dataset.value || el.dataset.type || null,
                isActive: el.classList.contains('active') || 
                          el.classList.contains('selected') ||
                          el.selected ||
                          el.getAttribute('aria-selected') === 'true',
              });
            });
          } catch (e) {
            // Ignore selector errors
          }
        }

        return found;
      })()
    `);
    return options;
  } catch {
    return [];
  }
}

export async function probeStreamOptions(pageUrl: string): Promise<StreamOptionsProbeResult> {
  log.info(`[stream-options-probe] Starting probe for ${pageUrl}`);

  const partitionName = `stream-options-${Date.now()}`;
  const probeSession = session.fromPartition(partitionName, { cache: true });

  const preloadDir = join(app.getPath('userData'), 'stream-options-probe');
  if (!existsSync(preloadDir)) mkdirSync(preloadDir, { recursive: true });
  const preloadPath = join(preloadDir, `spoof-${randomUUID()}.js`);
  writeFileSync(preloadPath, PRELOAD_SPOOF, 'utf-8');

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: {
      session: probeSession,
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  return new Promise((resolve) => {
    let settled = false;
    const capturedManifests = new Map<string, { url: string; type: 'm3u8' | 'mpd' | 'mp4'; timestamp: number }>();

    const finish = (result: StreamOptionsProbeResult) => {
      if (settled) return;
      settled = true;
      try { if (preloadPath) rmSync(preloadPath, { force: true }); } catch { }
      try { win.destroy(); } catch { }
      probeSession.clearStorageData().catch(() => { });
      resolve(result);
    };

    const timeout = setTimeout(() => {
      log.warn(`[stream-options-probe] Timed out after ${EXTRACTION_TIMEOUT_MS}ms`);
      // Return whatever we found
      const options = Array.from(capturedManifests.values()).map((m, idx) => ({
        label: idx === 0 ? 'Default Stream' : `Stream ${idx + 1}`,
        manifestUrl: m.url,
        manifestType: m.type,
        referer: pageUrl,
        isDefault: idx === 0,
      }));
      finish({
        success: options.length > 0,
        url: pageUrl,
        options,
        defaultOption: options[0],
      });
    }, EXTRACTION_TIMEOUT_MS);

    // Intercept manifest requests
    probeSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      if (settled) {
        callback({ cancel: true });
        return;
      }

      const match = details.url.match(MANIFEST_PATTERN);
      if (match) {
        const type = match[1].toLowerCase() as 'm3u8' | 'mpd' | 'mp4';
        log.info(`[stream-options-probe] Captured manifest: ${details.url}`);
        capturedManifests.set(details.url, { url: details.url, type, timestamp: Date.now() });
        // Don't cancel - let it load so the player works
      }

      callback({});
    });

    win.webContents.setUserAgent(SPOOF_UA);

    win.webContents.on('dom-ready', async () => {
      // Auto-click play buttons to initialize player
      try {
        await win.webContents.executeJavaScript(`
          const tryClick = (sel) => {
            document.querySelectorAll(sel).forEach(el => {
              if (el && typeof el.click === 'function') {
                try { el.click(); } catch {}
              }
            });
          };
          tryClick('button, .play, .vjs-big-play-button, .jw-video, .plyr__control--overlaid');
          tryClick('[class*="play"], [class*="Play"], [id*="play"], [id*="Play"]');
          document.querySelectorAll('video').forEach(v => {
            if (v.paused) v.play().catch(() => {});
          });
        `);
      } catch {
        // Ignore
      }
    });

    win.webContents.on('did-fail-load', (_event, code, desc) => {
      log.warn(`[stream-options-probe] Page load failed (${code}): ${desc}`);
      finish({ success: false, url: pageUrl, options: [], error: `Load failed: ${desc}` });
    });

    log.info(`[stream-options-probe] Loading page: ${pageUrl}`);
    win.loadURL(pageUrl).catch((err) => {
      log.warn(`[stream-options-probe] loadURL error: ${err}`);
      finish({ success: false, url: pageUrl, options: [], error: String(err) });
    });

    // Main orchestration
    win.webContents.on('did-finish-load', async () => {
      if (settled) return;

      // Wait for player to initialize
      await waitForPlayer(win);
      await new Promise(r => setTimeout(r, POST_LOAD_WAIT_MS));

      // Snapshot initial manifests (default stream)
      const initialManifests = Array.from(capturedManifests.values());
      log.info(`[stream-options-probe] Initial manifests found: ${initialManifests.length}`);

      // Discover language options
      const languageOptions = await discoverLanguageOptions(win);
      log.info(`[stream-options-probe] Language options found: ${languageOptions.length}`);
      languageOptions.forEach((opt, i) => {
        log.info(`[stream-options-probe]   Option ${i}: text="${opt.text}", query="${opt.query}", index=${opt.index}, isActive=${opt.isActive}, value="${opt.value}"`);
      });

      if (languageOptions.length === 0) {
        // No language switcher found - return what we have
        const options = initialManifests.map((m, idx) => ({
          label: idx === 0 ? 'Default' : `Stream ${idx + 1}`,
          manifestUrl: m.url,
          manifestType: m.type,
          referer: pageUrl,
          isDefault: idx === 0,
        }));
        finish({
          success: options.length > 0,
          url: pageUrl,
          options,
          defaultOption: options[0],
        });
        return;
      }

      // Click through each option and capture new manifests
      const allOptions: StreamOption[] = [];
      const processedLabels = new Set<string>();

      // Add initial default option
      if (initialManifests.length > 0) {
        const first = initialManifests[0];
        const defaultLabel = languageOptions.find(o => o.isActive)?.text || 'Default';
        let normalizedLabel = normalizeLanguageLabel(defaultLabel);
        if (normalizedLabel === 'Unknown' || normalizedLabel === 'Default' || /^stream \d+$/i.test(normalizedLabel)) {
          normalizedLabel = inferLabelFromManifestUrl(first.url, 0);
        }
        allOptions.push({
          label: normalizedLabel,
          manifestUrl: first.url,
          manifestType: first.type,
          referer: pageUrl,
          isDefault: true,
        });
        processedLabels.add(normalizedLabel);
      }

      for (const option of languageOptions) {
        if (settled) break;

        const label = normalizeLanguageLabel(option.text);
        if (processedLabels.has(label)) continue; // Skip duplicates
        if (!option.text.trim()) continue; // Skip empty labels

        log.info(`[stream-options-probe] Clicking option: "${label}" (query: ${option.query}[${option.index}])`);

        const beforeCount = capturedManifests.size;

        // Click the option
        try {
          await win.webContents.executeJavaScript(`
            (() => {
              const elements = document.querySelectorAll(${JSON.stringify(option.query)});
              const el = elements[${option.index}];
              if (el) {
                el.click();
                el.dispatchEvent(new Event('change', { bubbles: true }));
                // Some sites need a delay after click
                return true;
              }
              return false;
            })()
          `);
        } catch {
          continue;
        }

        // Wait for new network requests
        await new Promise(r => setTimeout(r, 1500));

        // Check for new manifests
        const afterCount = capturedManifests.size;
        if (afterCount > beforeCount) {
          const entries = Array.from(capturedManifests.values());
          const newManifests = entries.slice(beforeCount);
          if (newManifests.length > 0) {
            const newest = newManifests[newManifests.length - 1];
            // If label is generic/unknown, try to infer from manifest URL
            const finalLabel = (label === 'Unknown' || label === '' || /^stream \d+$/i.test(label))
              ? inferLabelFromManifestUrl(newest.url, allOptions.length)
              : label;
            allOptions.push({
              label: finalLabel,
              manifestUrl: newest.url,
              manifestType: newest.type,
              referer: pageUrl,
              isDefault: false,
            });
            processedLabels.add(finalLabel);
            log.info(`[stream-options-probe] Found stream for "${finalLabel}": ${newest.url}`);
          }
        }
      }

      clearTimeout(timeout);

      if (allOptions.length === 0) {
        finish({ success: false, url: pageUrl, options: [], error: 'No stream options found' });
      } else {
        finish({
          success: true,
          url: pageUrl,
          options: allOptions,
          defaultOption: allOptions.find(o => o.isDefault) || allOptions[0],
        });
      }
    });
  });
}

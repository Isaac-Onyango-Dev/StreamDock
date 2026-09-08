// Role: discover language-specific manifest URLs by interacting with DOM language switchers
// and intercepting the resulting network requests (Approach C from AI discussion).

import { app, BrowserWindow, session } from 'electron';
import log from 'electron-log';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getProbeStrategy } from './url-router';
import { probeViaYtDlp } from './manifest-extractor';
import {
  classifyLanguageHints,
  type LanguageClassification,
  type LanguageConfidence,
  type TranslationType,
} from '../shared/language';

export interface StreamOption {
  label: string;
  manifestUrl: string;
  manifestType: 'm3u8' | 'mpd' | 'mp4';
  referer?: string;
  isDefault: boolean;
  /** Display language, independent of `label` (which may be a server or CDN
   *  name like "MegaCloud" rather than a language). Always populated —
   *  'Unknown' when nothing usable was found, so the UI never has to leave
   *  this blank. */
  language: string;
  /** Dub / sub / raw, carried separately from the spoken language. */
  translation: TranslationType;
  /** Whether `language` was declared by the source or guessed from a URL. The
   *  UI marks an inferred value so a guess never reads as a fact. */
  languageConfidence: LanguageConfidence;
}

export interface StreamOptionsProbeResult {
  success: boolean;
  url: string;
  options: StreamOption[];
  defaultOption?: StreamOption;
  error?: string;
}

const MANIFEST_PATTERN = /\.(m3u8|mpd|mp4)(\?|$)/i;

/**
 * Project a shared classification onto the three StreamOption fields.
 *
 * Kept as one spread so a construction site cannot set the label while
 * forgetting the confidence — which is how the two classifiers drifted apart
 * in the first place.
 */
function toStreamLanguage(
  classification: LanguageClassification,
): Pick<StreamOption, 'language' | 'translation' | 'languageConfidence'> {
  return {
    language: classification.label,
    translation: classification.translation,
    languageConfidence: classification.confidence,
  };
}


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

// Budget: page load plus one OPTION_MANIFEST_WAIT_MS per language option.
// Four options at ten seconds each did not fit in the old 60s ceiling, so
// the probe was cut off mid-way through clicking them.
const EXTRACTION_TIMEOUT_MS = 90_000;
const POST_LOAD_WAIT_MS = 3000;
/** How long to wait for a language switch to produce its own manifest. */
const OPTION_MANIFEST_WAIT_MS = 10_000;

/**
 * Turn a language switcher's button text into a display label.
 *
 * The language half of this was a fourth copy of the same substring tests and
 * delegates to the shared model now. What server serves a stream, and at what
 * quality, are different facts and stay here.
 */
function normalizeLanguageLabel(raw: string): string {
  const classified = classifyLanguageHints(raw);
  if (classified.confidence !== 'unknown') return classified.label;

  const lower = raw.toLowerCase();
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

/**
 * A display label for an option whose own button text was never captured.
 *
 * The language half of this was a third copy of the substring classifier, with
 * the same `includes('en')` defect, and it disagreed with the badge beside it.
 * It delegates now. Which CDN serves a stream is a different fact from what
 * language it is in, so that half stays here.
 */
function inferLabelFromManifestUrl(manifestUrl: string, index: number): string {
  const classified = classifyLanguageHints(manifestUrl);
  if (classified.confidence !== 'unknown') return classified.label;

  const lower = manifestUrl.toLowerCase();
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

  if (getProbeStrategy(pageUrl) === 'ytdlp') {
    try {
      log.info(`[stream-options-probe] Routing to yt-dlp probe: ${pageUrl}`);
      const manifest = await probeViaYtDlp(pageUrl);
      const options: StreamOption[] = manifest.formats
        .filter(f => f.url.includes('m3u8') || f.url.includes('mpd'))
        .map((f, i) => ({
          label: f.formatId || `Stream ${i + 1}`,
          manifestUrl: f.url,
          manifestType: f.url.includes('mpd') ? 'mpd' : 'm3u8',
          referer: pageUrl,
          isDefault: i === 0,
          ...toStreamLanguage(classifyLanguageHints(f.formatId, f.url)),
        }));
      return { success: options.length > 0, url: pageUrl, options, defaultOption: options[0] };
    } catch (e) {
      log.warn(`[stream-options-probe] yt-dlp probe failed: ${e}`);
      return { success: false, url: pageUrl, options: [], error: String(e) };
    }
  }

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

  // Priority 1: Mute audio immediately (before loadURL)
  win.webContents.setAudioMuted(true);

  // Priority 2: Prevent ad popups
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  return new Promise((resolve) => {
    let settled = false;
    const capturedManifests = new Map<string, { url: string; type: 'm3u8' | 'mpd' | 'mp4'; timestamp: number }>();

    const finish = (result: StreamOptionsProbeResult) => {
      if (settled) return;
      settled = true;
      try { if (preloadPath) rmSync(preloadPath, { force: true }); } catch { /* temp file cleanup is best-effort */ }
      try { win.destroy(); } catch { /* window may already be gone */ }
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
        ...toStreamLanguage(classifyLanguageHints(m.url)),
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
          ...toStreamLanguage(classifyLanguageHints(m.url)),
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
          ...toStreamLanguage(classifyLanguageHints(defaultLabel, first.url)),
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

        // Wait for the new manifest, rather than hoping it lands in a fixed
        // window. Measured on anikototv.to: the initial manifest appears about
        // ten seconds after the page loads, so the old flat 1500ms wait expired
        // long before a language switch could produce anything. Every click
        // then looked like it had changed nothing, the probe returned the one
        // manifest it started with, and the UI reported no language streams at
        // all — while the log showed it had found and clicked SUB and DUB.
        // Polling costs nothing when the manifest arrives quickly.
        const deadline = Date.now() + OPTION_MANIFEST_WAIT_MS;
        while (Date.now() < deadline && !settled) {
          if (capturedManifests.size > beforeCount) break;
          await new Promise(r => setTimeout(r, 250));
        }

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
              ...toStreamLanguage(classifyLanguageHints(option.text, newest.url)),
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

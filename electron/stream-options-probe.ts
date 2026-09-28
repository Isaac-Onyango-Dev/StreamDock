// Role: discover language-specific manifest URLs by interacting with DOM language switchers
// and intercepting the resulting network requests (Approach C from AI discussion).

import type { BrowserWindow } from 'electron';
import log from 'electron-log';
import { getProbeStrategy } from './url-router';
import { probeViaYtDlp } from './manifest-extractor';
import { mediaTypeFromUrl, openHiddenProbe, runInPage, type StreamType } from './probe-support';
import {
  classifyDeclaredTranslation,
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
  return runInPage<boolean>(win, `
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

interface DiscoveredOption {
  query: string;
  index: number;
  text: string;
  value: string | null;
  isActive: boolean;
  /** Translation type the page states outright, e.g. data-type="sub". */
  declaredLanguage?: string;
}

async function discoverLanguageOptions(win: BrowserWindow): Promise<DiscoveredOption[]> {
  try {
    const options = await runInPage<DiscoveredOption[]>(win, `
      (() => {
        const queries = ${JSON.stringify(LANGUAGE_SELECTOR_QUERIES)};
        const found = [];

        // Sites that state the language on a container. anikoto renders
        //   <div class="type" data-type="sub"><label>SUB</label><ul><li>HD-1</li>…
        // so the container itself is not clickable — clicking it does nothing
        // at all, which is why every language switch used to capture no new
        // manifest. The clickable elements are the server items inside it, and
        // the container's data-type is a language the site declares rather than
        // one we infer. One representative server per language is enough: the
        // user is choosing dub or sub, not which CDN serves it.
        for (const type of ['sub', 'dub', 'raw']) {
          const query = '[data-type="' + type + '"] li, [data-type="' + type + '"] button';
          try {
            const elements = document.querySelectorAll(query);
            if (!elements.length) continue;
            let index = 0;
            elements.forEach((el, i) => {
              if (el.classList && el.classList.contains('active')) index = i;
            });
            const chosen = elements[index];
            found.push({
              query,
              index,
              text: chosen.textContent?.trim() || type,
              value: type,
              isActive: Boolean(chosen.classList && chosen.classList.contains('active')),
              declaredLanguage: type,
            });
          } catch (e) {
            // Ignore selector errors
          }
        }

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

type CapturedManifest = { url: string; type: StreamType; timestamp: number; referer?: string };

/**
 * Probe a page for the language streams it offers.
 *
 * Rejects with the signal's reason when `signal` aborts; the hidden window is
 * torn down either way.
 */
export async function probeStreamOptions(pageUrl: string, signal?: AbortSignal): Promise<StreamOptionsProbeResult> {
  log.info(`[stream-options-probe] Starting probe for ${pageUrl}`);
  signal?.throwIfAborted();

  if (getProbeStrategy(pageUrl) === 'ytdlp') {
    try {
      log.info(`[stream-options-probe] Routing to yt-dlp probe: ${pageUrl}`);
      const manifest = await probeViaYtDlp(pageUrl, signal);
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
      if (signal?.aborted) throw signal.reason;
      log.warn(`[stream-options-probe] yt-dlp probe failed: ${e}`);
      return { success: false, url: pageUrl, options: [], error: String(e) };
    }
  }

  const { win, session: probeSession, dispose } = openHiddenProbe();

  return new Promise((resolve, reject) => {
    let settled = false;
    let orchestrating = false;
    // HLS/DASH manifests only. An .mp4 is also what an ad creative is, and a
    // click that produced one used to count as that language's stream; mp4s
    // are listed only when the page offered nothing else at all.
    const capturedManifests = new Map<string, CapturedManifest>();
    const capturedMp4s = new Map<string, CapturedManifest>();
    const whatWeHave = (): CapturedManifest[] =>
      Array.from((capturedManifests.size > 0 ? capturedManifests : capturedMp4s).values());

    const end = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      dispose();
      settle();
    };
    const finish = (result: StreamOptionsProbeResult) => end(() => resolve(result));
    const onAbort = () => end(() => reject(signal?.reason));
    signal?.addEventListener('abort', onAbort, { once: true });

    const timeout = setTimeout(() => {
      log.warn(`[stream-options-probe] Timed out after ${EXTRACTION_TIMEOUT_MS}ms`);
      // Return whatever we found
      const options = whatWeHave().map((m, idx) => ({
        label: idx === 0 ? 'Default Stream' : `Stream ${idx + 1}`,
        manifestUrl: m.url,
        manifestType: m.type,
        referer: m.referer || pageUrl,
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

      const type = mediaTypeFromUrl(details.url);
      if (type) {
        log.info(`[stream-options-probe] Captured ${type === 'mp4' ? 'mp4' : 'manifest'}: ${details.url}`);
        (type === 'mp4' ? capturedMp4s : capturedManifests)
          .set(details.url, { url: details.url, type, timestamp: Date.now() });
        // Don't cancel - let it load so the player works
      }

      callback({});
    });

    // The Referer the *player* sends is not the page the user pasted.
    // anikoto's CDN serves the manifest only for `Referer: https://megaplay.buzz/`
    // — the embed origin — and returns 403 for the anikoto page URL, which is
    // what the engine was handing yt-dlp. Verified against the live CDN: UA plus
    // the megaplay referer returns 200, every other referer tested returns 403,
    // and no cookie is involved. Capturing the header the browser actually sent
    // keeps this correct for any host rather than hardcoding one CDN's rule.
    probeSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
      const captured = capturedManifests.get(details.url) ?? capturedMp4s.get(details.url);
      if (captured && !captured.referer) {
        const headers = details.requestHeaders;
        const referer = headers['Referer'] || headers['referer'];
        if (referer) captured.referer = referer;
      }
      callback({ requestHeaders: details.requestHeaders });
    });

    win.webContents.on('dom-ready', () => {
      // Auto-click play buttons to initialize player
      runInPage(win, `
        (() => {
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
        })()
      `).catch(() => { });
    });

    // Only the page itself failing ends the probe. Any failure used to count,
    // so one broken ad iframe returned "no stream options" for a healthy page.
    // ERR_ABORTED (-3) is a navigation superseded by a newer one, not a failure.
    win.webContents.on('did-fail-load', (_event, code, desc, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      log.warn(`[stream-options-probe] Page load failed (${code}): ${desc}`);
      finish({ success: false, url: pageUrl, options: [], error: `Load failed: ${desc}` });
    });

    log.info(`[stream-options-probe] Loading page: ${pageUrl}`);
    win.loadURL(pageUrl).catch((err) => {
      // did-fail-load has already decided what this failure means; a page
      // that redirects itself rejects this promise with ERR_ABORTED.
      log.debug(`[stream-options-probe] loadURL settled with: ${err}`);
    });

    // Main orchestration, once. It was bound with `on`, so a page that loaded
    // twice started a second click-through racing the first over one window.
    win.webContents.on('did-finish-load', () => {
      if (settled || orchestrating) return;
      orchestrating = true;
      // An await inside an event handler has nobody to reject to: when the
      // timeout destroyed the window mid-probe, the next executeJavaScript
      // threw into an unhandled rejection.
      orchestrate().catch((err) => {
        if (!settled) log.warn(`[stream-options-probe] Probe stopped: ${err}`);
        finish({ success: false, url: pageUrl, options: [], error: String(err) });
      });
    });

    const orchestrate = async (): Promise<void> => {
      // Wait for player to initialize
      await waitForPlayer(win);
      await new Promise(r => setTimeout(r, POST_LOAD_WAIT_MS));
      if (settled) return;

      // Snapshot initial manifests (default stream)
      const initialManifests = whatWeHave();
      log.info(`[stream-options-probe] Initial manifests found: ${initialManifests.length}`);

      // Discover language options
      let languageOptions = await discoverLanguageOptions(win);
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
          referer: m.referer || pageUrl,
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

      // A site that states its languages does not need guessing. Restricting to
      // the declared set also drops the false positives the broad selectors
      // produce on anikoto — a "Contribute" button matched by
      // `[class*="sub"] button`, and a "720p1080p" quality row — each of which
      // otherwise costs a click and a full manifest wait for nothing.
      const declaredOptions = languageOptions.filter((option) => option.declaredLanguage);
      if (declaredOptions.length > 0) {
        languageOptions = declaredOptions;
        log.info(`[stream-options-probe] Using ${languageOptions.length} declared language option(s)`);
      }

      // Click through each option and capture new manifests
      const allOptions: StreamOption[] = [];
      const processedLabels = new Set<string>();

      // Add initial default option
      if (initialManifests.length > 0) {
        const first = initialManifests[0];
        const active = languageOptions.find(o => o.isActive);
        // The page loads with one language already selected. Where the site
        // declares which, that is the label: the *server* name ("Vidstream-2")
        // is not a language, and using it here collapsed the whole list — both
        // the sub and dub entries are served by a server of the same name, so
        // the label-keyed dedupe below discarded both and the probe returned a
        // single nameless option.
        const activeClassification = active?.declaredLanguage
          ? classifyDeclaredTranslation(active.declaredLanguage)
          : classifyLanguageHints(active?.text, first.url);
        let normalizedLabel =
          activeClassification.confidence === 'unknown'
            ? normalizeLanguageLabel(active?.text || 'Default')
            : activeClassification.label;
        if (normalizedLabel === 'Unknown' || normalizedLabel === 'Default' || /^stream \d+$/i.test(normalizedLabel)) {
          normalizedLabel = inferLabelFromManifestUrl(first.url, 0);
        }
        allOptions.push({
          label: normalizedLabel,
          manifestUrl: first.url,
          manifestType: first.type,
          referer: first.referer || pageUrl,
          isDefault: true,
          ...toStreamLanguage(activeClassification),
        });
        processedLabels.add(normalizedLabel);
      }

      for (const option of languageOptions) {
        if (settled) break;

        // A declared language names itself; only a guessed option falls back to
        // its button text.
        const label = option.declaredLanguage
          ? classifyDeclaredTranslation(option.declaredLanguage).label
          : normalizeLanguageLabel(option.text);
        if (processedLabels.has(label)) continue; // Skip duplicates
        if (!option.text.trim()) continue; // Skip empty labels

        log.info(`[stream-options-probe] Clicking option: "${label}" (query: ${option.query}[${option.index}])`);

        const beforeCount = capturedManifests.size;

        // Click the option
        try {
          await runInPage(win, `
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
              referer: newest.referer || pageUrl,
              isDefault: false,
              ...toStreamLanguage(
                option.declaredLanguage
                  ? classifyDeclaredTranslation(option.declaredLanguage)
                  : classifyLanguageHints(option.text, newest.url),
              ),
            });
            processedLabels.add(finalLabel);
            log.info(`[stream-options-probe] Found stream for "${finalLabel}": ${newest.url}`);
          }
        }
      }

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
    };
  });
}

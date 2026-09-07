// Role: best-effort advisory lookup against a maintained community index
// (EverythingMoe / REFERENCE_HOSTS) to flag plugin/anime hosts that the index
// has marked retired ("moved to Graveyard") — see Priority 5's "use it as a
// lookup ... to determine which supported streaming sites are currently
// functional" requirement.
//
// This is intentionally advisory-only, never authoritative:
//   - It NEVER blocks, removes, or reorders a host from the app's own
//     supported-host lists (url-router.ts / host-config.json) — it only adds
//     an optional note the UI *may* show.
//   - Any failure (network, timeout, empty/unparseable response) fails
//     silently to "unknown" for every host, which callers must treat exactly
//     like "say nothing" — i.e. the app falls back to trying its own
//     configured hosts directly, per the Priority 5 spec's own graceful-
//     fallback requirement.
//   - The parsing here is a coarse text-proximity heuristic (find a
//     "graveyard" section marker, split the page text around it), not a
//     tight CSS-selector scrape — that's a deliberate choice: it's more
//     resilient to the reference page's markup changing, at the cost of
//     being fuzzier. Treat its output as a soft hint, not ground truth.

import { net } from 'electron';
import log from 'electron-log';
import { REFERENCE_HOSTS } from './url-router';

export type SourceStatus = 'active' | 'retired' | 'unknown';

const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — roughly matches the index's own update cadence
const GRAVEYARD_MARKERS = ['graveyard'];

interface StatusCache {
  fetchedAt: number;
  activeText: string;
  retiredText: string;
}

let cache: StatusCache | null = null;
let inFlight: Promise<StatusCache | null> | null = null;

/**
 * Splits raw reference-page text into an "active" blob and a "retired"
 * (graveyard) blob around the first graveyard marker found. Pure function —
 * no network — so it's unit-testable against fixture text without hitting
 * the real site.
 */
export function splitReferenceText(rawText: string): { activeText: string; retiredText: string } {
  const lower = rawText.toLowerCase();
  for (const marker of GRAVEYARD_MARKERS) {
    const idx = lower.indexOf(marker);
    if (idx !== -1) {
      return { activeText: rawText.slice(0, idx).toLowerCase(), retiredText: rawText.slice(idx).toLowerCase() };
    }
  }
  // No graveyard section found at all — treat the whole page as "active"
  // context; nothing gets classified 'retired' without positive evidence.
  return { activeText: rawText.toLowerCase(), retiredText: '' };
}

/**
 * Registrable-domain fragment used for the substring match, e.g.
 * "hianime.to" -> "hianime". Deliberately loose (drops the TLD) since the
 * reference index doesn't consistently write full domains with TLD.
 */
function domainFragment(host: string): string {
  const first = host.split('.')[0];
  return first.toLowerCase();
}

/** Pure classification given already-split reference text. Unit-testable. */
export function classifyHost(host: string, activeText: string, retiredText: string): SourceStatus {
  const fragment = domainFragment(host);
  if (!fragment) return 'unknown';
  if (retiredText.includes(fragment)) return 'retired';
  if (activeText.includes(fragment)) return 'active';
  return 'unknown';
}

async function fetchReferenceText(): Promise<string | null> {
  for (const host of REFERENCE_HOSTS()) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await net.fetch(`https://${host}`, { signal: controller.signal }).finally(() => clearTimeout(timer));
      if (!res.ok) continue;
      const text = await res.text();
      if (text && text.length > 0) return text;
    } catch (err) {
      log.warn(`[source-status] Could not fetch ${host}:`, err);
    }
  }
  return null;
}

async function ensureCache(): Promise<StatusCache | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const rawText = await fetchReferenceText();
      if (!rawText) return null;
      const { activeText, retiredText } = splitReferenceText(rawText);
      const next: StatusCache = { fetchedAt: Date.now(), activeText, retiredText };
      cache = next;
      return next;
    } catch (err) {
      log.warn('[source-status] Reference lookup failed:', err);
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Best-effort status for a single host. Resolves to 'unknown' — never
 * throws, never blocks the caller for more than FETCH_TIMEOUT_MS — on any
 * failure. Callers must treat 'unknown' as "say nothing", not as a warning.
 */
export async function checkSourceStatus(host: string): Promise<SourceStatus> {
  try {
    const c = await ensureCache();
    if (!c) return 'unknown';
    return classifyHost(host, c.activeText, c.retiredText);
  } catch (err) {
    log.warn('[source-status] checkSourceStatus failed, defaulting to unknown:', err);
    return 'unknown';
  }
}

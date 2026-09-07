// Role: yt-dlp version validation at startup — warns if outdated.
import { execFile } from 'child_process';
import log from 'electron-log';

/**
 * yt-dlp ships roughly monthly, and site extractors (YouTube especially) break
 * continuously between releases. A binary only a few months old is already
 * failing in the wild — yt-dlp itself prints "your version is older than 90
 * days" and recommends updating.
 *
 * This used to be a hardcoded `MIN_VERSION = '2024.01.01'` floor, which is why
 * nothing ever warned: a six-month-stale 2026.03.17 binary compared as "newer
 * than 2024.01.01" and was reported as OK, while it 403'd on every YouTube
 * download. Age is the property that actually matters, and unlike a pinned
 * date it never needs bumping.
 */
const STALE_AFTER_DAYS = 30;
const SEVERELY_STALE_AFTER_DAYS = 90;

/** Absolute floor — anything this old predates extractor rewrites we depend on. */
const HARD_MIN_VERSION = '2024.01.01';

export interface VersionCheckResult {
  available: boolean;
  version: string | null;
  /** Whole days between the version's release date and now; null if unparseable. */
  ageDays: number | null;
  isOutdated: boolean;
  /** True when the engine is old enough to be a likely cause of download failures. */
  isSeverelyOutdated: boolean;
  warning: string | null;
}

function parseVersion(raw: string): string | null {
  const match = raw.trim().match(/(\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)/);
  return match ? match[1] : null;
}

/** yt-dlp versions are release dates (YYYY.MM.DD[.N]) — convert to an age in days. */
export function versionAgeDays(version: string, now: Date = new Date()): number | null {
  const match = version.match(/^(\d{4})\.(\d{2})\.(\d{2})/);
  if (!match) return null;
  const released = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(released)) return null;
  const days = Math.floor((now.getTime() - released) / 86_400_000);
  // A future-dated version means a clock skew, not a fresh binary — treat as 0.
  return days < 0 ? 0 : days;
}

export interface StalenessVerdict {
  isOutdated: boolean;
  isSeverelyOutdated: boolean;
  warning: string | null;
}

/** Decide whether a parsed yt-dlp version is stale enough to warn about. */
export function assessVersion(version: string, now: Date = new Date()): StalenessVerdict {
  const ageDays = versionAgeDays(version, now);

  if (version < HARD_MIN_VERSION) {
    return {
      isOutdated: true,
      isSeverelyOutdated: true,
      warning:
        `The download engine (yt-dlp ${version}) is far too old to work with most sites. ` +
        'Update it now.',
    };
  }

  if (ageDays === null) {
    return { isOutdated: false, isSeverelyOutdated: false, warning: null };
  }

  if (ageDays >= SEVERELY_STALE_AFTER_DAYS) {
    return {
      isOutdated: true,
      isSeverelyOutdated: true,
      warning:
        `The download engine (yt-dlp ${version}) is ${ageDays} days old. ` +
        'Downloads are likely to fail until it is updated.',
    };
  }

  if (ageDays >= STALE_AFTER_DAYS) {
    return {
      isOutdated: true,
      isSeverelyOutdated: false,
      warning:
        `A newer download engine is available (yt-dlp ${version} is ${ageDays} days old). ` +
        'Updating improves site compatibility.',
    };
  }

  return { isOutdated: false, isSeverelyOutdated: false, warning: null };
}

export async function checkYtDlpVersion(command: string, baseArgs: string[] = []): Promise<VersionCheckResult> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      log.warn('[version-checker] yt-dlp version check timed out');
      resolve({ available: false, version: null, ageDays: null, isOutdated: false, isSeverelyOutdated: false, warning: null });
    }, 8_000);

    execFile(command, [...baseArgs, '--version'], { windowsHide: true, encoding: 'utf-8' }, (error, stdout, stderr) => {
      clearTimeout(timeout);

      if (error) {
        log.error('[version-checker] Failed to check yt-dlp version:', error.message);
        resolve({ available: false, version: null, ageDays: null, isOutdated: false, isSeverelyOutdated: false, warning: null });
        return;
      }

      const version = parseVersion(stdout || stderr || '');
      if (!version) {
        log.warn('[version-checker] Could not parse yt-dlp version from output:', stdout);
        resolve({ available: true, version: null, ageDays: null, isOutdated: false, isSeverelyOutdated: false, warning: null });
        return;
      }

      const ageDays = versionAgeDays(version);
      const verdict = assessVersion(version);

      if (verdict.warning) {
        log.warn(`[version-checker] ${verdict.warning}`);
      } else {
        log.info(`[version-checker] yt-dlp version ${version} (${ageDays ?? '?'} days old) — OK`);
      }

      resolve({ available: true, version, ageDays, ...verdict });
    });
  });
}

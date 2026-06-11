// Role: yt-dlp version validation at startup — warns if outdated.
import { execFile } from 'child_process';
import log from 'electron-log';

/** Minimum acceptable yt-dlp version (YYYY.MM.DD format). */
const MIN_VERSION = '2024.01.01';

export interface VersionCheckResult {
  available: boolean;
  version: string | null;
  isOutdated: boolean;
  warning: string | null;
}

function parseVersion(raw: string): string | null {
  const match = raw.trim().match(/(\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)/);
  return match ? match[1] : null;
}

function isVersionOutdated(version: string): boolean {
  // Compare YYYY.MM.DD versions lexicographically (works since format is zero-padded)
  return version < MIN_VERSION;
}

export async function checkYtDlpVersion(command: string, baseArgs: string[] = []): Promise<VersionCheckResult> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      log.warn('[version-checker] yt-dlp version check timed out');
      resolve({ available: false, version: null, isOutdated: false, warning: null });
    }, 8_000);

    execFile(command, [...baseArgs, '--version'], { windowsHide: true, encoding: 'utf-8' }, (error, stdout, stderr) => {
      clearTimeout(timeout);

      if (error) {
        log.error('[version-checker] Failed to check yt-dlp version:', error.message);
        resolve({ available: false, version: null, isOutdated: false, warning: null });
        return;
      }

      const version = parseVersion(stdout || stderr || '');
      if (!version) {
        log.warn('[version-checker] Could not parse yt-dlp version from output:', stdout);
        resolve({ available: true, version: null, isOutdated: false, warning: null });
        return;
      }

      const isOutdated = isVersionOutdated(version);
      const warning = isOutdated
        ? `yt-dlp ${version} is outdated. Update it for best compatibility (minimum: ${MIN_VERSION}).`
        : null;

      if (warning) {
        log.warn(`[version-checker] ${warning}`);
      } else {
        log.info(`[version-checker] yt-dlp version ${version} — OK`);
      }

      resolve({ available: true, version, isOutdated, warning });
    });
  });
}

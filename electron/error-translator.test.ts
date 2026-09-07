import { describe, expect, it, vi } from 'vitest';

vi.mock('electron-log', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  toUserError,
  toErrorDetail,
  isRateLimited,
  isAuthRequired,
  isGeoBlocked,
  mentionsStaleEngine,
  pickFatalLine,
  sanitizeRaw,
  isBotChallenged,
  classifyEngineFailure,
} = await import('./error-translator');

/**
 * Captured verbatim from streamdock.log, download 64b62cd0 — the failure behind
 * the "This content requires a login" report. anikoto.cz's CDN sits behind
 * Cloudflare bot management: the ?token= is valid and freshly minted, and the
 * request is refused at the edge before it ever reaches the origin. There is no
 * account on any site that would change the outcome.
 */
const CDN_MANIFEST_403 =
  'ERROR: [generic] master.m3u8?token=MTc4ODc5NDE4M3xkNTgwNzJiZTI4MjBlODY4MmMwYTI3YzA1' +
  'MThlODA1ZS81ZWM4ZTIzNmExYTljYjZmYjBlMjNkNGZmY2M4ZGFlZg: Unable to download webpage: ' +
  'HTTP Error 403: Forbidden (caused by <HTTPError 403: Forbidden>)';

/**
 * Captured verbatim from the bundled 2026.03.17 yt-dlp failing a plain YouTube
 * download while the then-current release succeeded with identical arguments.
 * This is the failure the "Rate limited" report was actually about.
 */
const STALE_ENGINE_STDERR = [
  'WARNING: Your yt-dlp version (2026.03.17) is older than 90 days!',
  '         It is strongly recommended to always use the latest version.',
  '         Run "yt-dlp --update" or "yt-dlp -U" to update.',
  '         To suppress this warning, add --no-update to your command/config.',
  'WARNING: [youtube] No supported JavaScript runtime could be found.',
  'ERROR: unable to download video data: HTTP Error 403: Forbidden',
].join('\n');

describe('isRateLimited', () => {
  it('matches a real 429', () => {
    expect(isRateLimited('ERROR: HTTP Error 429: Too Many Requests')).toBe(true);
    expect(isRateLimited('ERROR: rate-limited by the server')).toBe(true);
  });

  // The bare `includes('429')` this replaced fired on any of these, which is
  // how unrelated failures got reported to users as "Rate limited".
  it('does not fire on an incidental 429 elsewhere in the output', () => {
    expect(isRateLimited('[download] Downloading fragment 429 of 1200')).toBe(false);
    expect(isRateLimited('ERROR: unable to extract video id abc429xyz')).toBe(false);
    expect(isRateLimited('[download] 100% of 429.15MiB')).toBe(false);
  });
});

describe('isAuthRequired', () => {
  it('matches a real 403/401 and login walls', () => {
    expect(isAuthRequired('ERROR: HTTP Error 403: Forbidden')).toBe(true);
    expect(isAuthRequired('ERROR: HTTP Error 401: Unauthorized')).toBe(true);
    expect(isAuthRequired('ERROR: This video is private video')).toBe(true);
  });

  // Captured from a real Vimeo failure: some extractors state the login
  // requirement in prose instead of returning a status we could match.
  it('matches a prose login requirement with no status code', () => {
    expect(
      isAuthRequired(
        'ERROR: [vimeo] 76979871: The web client only works when logged-in. ' +
        'Use --cookies, --username and --password to provide account credentials',
      ),
    ).toBe(true);
  });

  // 403 is a real YouTube AV1 itag, so a format-selection failure used to be
  // reported as "this content requires a login".
  it('does not fire on itag 403 or other incidental digits', () => {
    expect(isAuthRequired('ERROR: requested format 403 is not available')).toBe(false);
    expect(isAuthRequired('[info] Downloading 1 format(s): 403+251')).toBe(false);
  });
});

describe('isGeoBlocked', () => {
  it('matches real geo-blocks', () => {
    expect(isGeoBlocked('ERROR: The uploader has not made this video available in your country')).toBe(true);
    expect(isGeoBlocked('ERROR: This video is geo-restricted')).toBe(true);
  });

  // Previously a bare 'geo'/'region' substring, which matched ordinary text.
  it('does not fire on incidental words', () => {
    expect(isGeoBlocked('ERROR: connecting to eu-region-3.cdn.example')).toBe(false);
    expect(isGeoBlocked('[debug] geoip lookup skipped')).toBe(false);
  });
});

describe('pickFatalLine', () => {
  it('returns the last ERROR line, ignoring warnings above it', () => {
    expect(pickFatalLine(STALE_ENGINE_STDERR)).toBe(
      'ERROR: unable to download video data: HTTP Error 403: Forbidden',
    );
  });

  it('returns null when there is no ERROR line', () => {
    expect(pickFatalLine('WARNING: something harmless')).toBeNull();
  });
});

describe('mentionsStaleEngine', () => {
  it('detects yt-dlp reporting its own staleness', () => {
    expect(mentionsStaleEngine(STALE_ENGINE_STDERR)).toBe(true);
  });

  it('is false for ordinary output', () => {
    expect(mentionsStaleEngine('ERROR: HTTP Error 404: Not Found')).toBe(false);
  });
});

describe('toUserError', () => {
  it('blames the out-of-date engine for a stale-engine 403, not a login wall', () => {
    expect(toUserError(STALE_ENGINE_STDERR)).toMatch(/out of date/i);
  });

  it('still reports a genuine login wall when the engine is current', () => {
    expect(toUserError('ERROR: HTTP Error 403: Forbidden')).toMatch(/requires a login/i);
  });

  it('classifies the fatal line rather than an earlier warning', () => {
    const stderr = [
      'WARNING: unable to extract thumbnail; please report this',
      'ERROR: HTTP Error 404: Not Found',
    ].join('\n');
    expect(toUserError(stderr)).toMatch(/could not be found/i);
  });

  it('does not leak absolute paths', () => {
    const msg = toUserError('ERROR: unable to open file C:\\Users\\Isaac\\Videos\\clip.mp4');
    expect(msg).not.toContain('C:\\Users');
  });
});

describe('toErrorDetail', () => {
  it('keeps the real status code so a failure is diagnosable', () => {
    const detail = toErrorDetail(STALE_ENGINE_STDERR);
    expect(detail).toContain('HTTP Error 403');
    expect(detail).toContain('older than 90 days');
  });

  it('redacts paths and credentials', () => {
    const detail = toErrorDetail('ERROR: read C:\\Users\\Isaac\\cookies.txt\ncookie=abc123');
    expect(detail).not.toContain('C:\\Users');
    expect(detail).not.toContain('abc123');
  });

  it('returns null for empty input', () => {
    expect(toErrorDetail('   ')).toBeNull();
  });

  it('truncates from the front, keeping the tail where the failure is', () => {
    const detail = toErrorDetail(`${'noise\n'.repeat(500)}ERROR: the real problem`, 200);
    expect(detail).toContain('ERROR: the real problem');
    expect(detail!.length).toBeLessThanOrEqual(201);
  });
});

describe('secret redaction keeps the diagnosis intact', () => {
  it('redacts a query-string token without swallowing the rest of the line', () => {
    const cleaned = sanitizeRaw(CDN_MANIFEST_403);
    // The secret is gone…
    expect(cleaned).not.toContain('MTc4ODc5NDE4M3');
    expect(cleaned).toContain('[REDACTED]');
    // …but everything that explains the failure survives. The previous
    // end-of-line redaction left only "master.m3u8?token=[REDACTED]", which is
    // why the UI's "Show details" panel was useless on exactly the failures
    // that needed it.
    expect(cleaned).toContain('HTTP Error 403');
    expect(cleaned).toContain('Forbidden');
    expect(cleaned).toContain('Unable to download webpage');
  });

  it('still redacts a Cookie header to end of line', () => {
    const cleaned = sanitizeRaw('Cookie: session=abc123; cf_clearance=xyz789');
    expect(cleaned).not.toContain('abc123');
    expect(cleaned).not.toContain('xyz789');
  });

  it('redacts passwords and api keys without eating neighbouring text', () => {
    const cleaned = sanitizeRaw('login failed: password=hunter2 after 3 attempts');
    expect(cleaned).not.toContain('hunter2');
    expect(cleaned).toContain('after 3 attempts');
  });

  it('surfaces the real status through toErrorDetail', () => {
    const detail = toErrorDetail(CDN_MANIFEST_403);
    expect(detail).toContain('HTTP Error 403');
    expect(detail).not.toContain('MTc4ODc5NDE4M3');
  });
});

describe('isBotChallenged', () => {
  it('recognises yt-dlp naming a Cloudflare challenge', () => {
    expect(isBotChallenged(
      'ERROR: [generic] Got HTTP Error 403 caused by Cloudflare anti-bot challenge; try again with --extractor-args',
    )).toBe(true);
  });

  it("recognises Cloudflare's own block page", () => {
    expect(isBotChallenged('Sorry, you have been blocked')).toBe(true);
    expect(isBotChallenged('<title>Just a moment...</title>')).toBe(true);
  });

  it('does not fire on an incidental mention of a CDN vendor', () => {
    expect(isBotChallenged('[download] Destination: cdn.cloudflare-assets.example/video.mp4')).toBe(false);
    expect(isBotChallenged('ERROR: HTTP Error 404: Not Found')).toBe(false);
  });
});

describe('classifyEngineFailure', () => {
  it('does NOT call a resolved-manifest 403 a login wall', () => {
    const message = classifyEngineFailure(CDN_MANIFEST_403, { manifestAttempted: true });
    expect(message).not.toMatch(/requires a login/i);
    expect(message).not.toMatch(/log in/i);
    expect(message).toMatch(/403/);
  });

  it('reaches the same verdict from the URL alone, without the manifest flag', () => {
    // close() drops the task before failing, so the flag is not always available;
    // the CDN shape of the URL has to be enough on its own.
    const message = classifyEngineFailure(CDN_MANIFEST_403, {
      url: 'https://cdn.imgnex.top/anime/abc/master.m3u8?token=x',
    });
    expect(message).not.toMatch(/requires a login/i);
  });

  it('does not claim the link expired — that was never established', () => {
    const message = classifyEngineFailure(CDN_MANIFEST_403, { manifestAttempted: true });
    expect(message).not.toMatch(/expired/i);
  });

  it('still reports a genuine login wall as one', () => {
    const message = classifyEngineFailure(
      'ERROR: [youtube] abc123: Sign in to confirm your age. This video may be inappropriate for some users.',
      {},
    );
    expect(message).toMatch(/log in|login/i);
  });

  it('prefers a bot-challenge reading over a login reading for the same 403', () => {
    const message = classifyEngineFailure(
      'ERROR: [generic] Got HTTP Error 403 caused by Cloudflare anti-bot challenge',
      {},
    );
    expect(message).toMatch(/automated-traffic|browser/i);
    expect(message).not.toMatch(/requires a login/i);
  });

  it('a stale engine outranks the status it produced', () => {
    const message = classifyEngineFailure(
      `WARNING: your yt-dlp version 2026.03.17 is older than 90 days
${CDN_MANIFEST_403}`,
      { manifestAttempted: true },
    );
    expect(message).toMatch(/out of date/i);
  });

  it('reports a rate limit as a rate limit', () => {
    const message = classifyEngineFailure('ERROR: HTTP Error 429: Too Many Requests', {});
    expect(message).toMatch(/rate limited/i);
  });
});

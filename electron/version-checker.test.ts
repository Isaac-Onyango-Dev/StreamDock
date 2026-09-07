import { describe, expect, it, vi } from 'vitest';

vi.mock('electron-log', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { assessVersion, versionAgeDays } = await import('./version-checker');

const NOW = new Date('2026-09-07T00:00:00Z');

describe('versionAgeDays', () => {
  it('computes age from the release date encoded in the version', () => {
    expect(versionAgeDays('2026.08.19', NOW)).toBe(19);
    expect(versionAgeDays('2026.09.07', NOW)).toBe(0);
  });

  it('handles the four-component nightly form', () => {
    expect(versionAgeDays('2026.08.19.232301', NOW)).toBe(19);
  });

  it('clamps a future-dated version to zero rather than reporting negative age', () => {
    expect(versionAgeDays('2026.12.01', NOW)).toBe(0);
  });

  it('returns null for unparseable input', () => {
    expect(versionAgeDays('nightly', NOW)).toBeNull();
  });
});

describe('assessVersion', () => {
  it('accepts a current engine', () => {
    const verdict = assessVersion('2026.08.19', NOW);
    expect(verdict.isOutdated).toBe(false);
    expect(verdict.warning).toBeNull();
  });

  /**
   * The regression this replaced: a hardcoded `MIN_VERSION = '2024.01.01'`
   * floor meant a six-month-stale binary compared as "newer than the minimum"
   * and was reported as OK, so the update banner never appeared even while
   * that engine 403'd on every YouTube download.
   */
  it('flags a six-month-old engine as severely outdated', () => {
    const verdict = assessVersion('2026.03.17', NOW);
    expect(verdict.isOutdated).toBe(true);
    expect(verdict.isSeverelyOutdated).toBe(true);
    expect(verdict.warning).toMatch(/likely to fail/i);
  });

  it('nudges, without alarming, for a merely month-old engine', () => {
    const verdict = assessVersion('2026.08.01', NOW);
    expect(verdict.isOutdated).toBe(true);
    expect(verdict.isSeverelyOutdated).toBe(false);
    expect(verdict.warning).toMatch(/newer download engine/i);
  });

  it('treats anything below the hard floor as severely outdated', () => {
    const verdict = assessVersion('2023.06.01', NOW);
    expect(verdict.isSeverelyOutdated).toBe(true);
  });

  it('does not warn right at the staleness boundary', () => {
    expect(assessVersion('2026.08.09', NOW).isOutdated).toBe(false);
    expect(assessVersion('2026.08.08', NOW).isOutdated).toBe(true);
  });
});

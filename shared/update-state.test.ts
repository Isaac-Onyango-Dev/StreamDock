import { describe, it, expect } from 'vitest';
import {
  UPDATE_FALLBACK_URL,
  describeUpdateState,
  shouldSurface,
  type UpdateState,
} from './update-state';

describe('UPDATE_FALLBACK_URL', () => {
  it('is the project site, never a GitHub releases or tags page', () => {
    expect(UPDATE_FALLBACK_URL).toBe('https://isaac-onyango-dev.github.io/StreamDock/');
    expect(UPDATE_FALLBACK_URL).not.toContain('github.com');
    expect(UPDATE_FALLBACK_URL).not.toContain('/releases');
    expect(UPDATE_FALLBACK_URL).not.toContain('/tags');
  });
});

describe('describeUpdateState', () => {
  it('names the version being offered and the one running', () => {
    const d = describeUpdateState({ phase: 'available', version: '1.8.0', currentVersion: '1.7.0' });
    expect(d.headline).toContain('1.8.0');
    expect(d.detail).toContain('1.7.0');
    expect(d.tone).toBe('info');
  });

  it('says a download is in progress rather than going quiet', () => {
    const d = describeUpdateState({ phase: 'downloading', version: '1.8.0', percent: 42 });
    expect(d.headline).toMatch(/downloading/i);
    expect(d.tone).toBe('progress');
  });

  it('explains that a restart is what finishes the install', () => {
    const d = describeUpdateState({ phase: 'ready', version: '1.8.0' });
    expect(d.headline).toMatch(/ready to install/i);
    expect(d.detail).toMatch(/restart/i);
    expect(d.tone).toBe('success');
  });

  it('tells the user the download page is being opened, rather than redirecting silently', () => {
    const d = describeUpdateState({
      phase: 'error',
      detail: 'Could not download the update: ECONNRESET',
      openedFallback: true,
    });
    expect(d.headline).toBe("Couldn't update automatically — opening the download page instead.");
    expect(d.tone).toBe('error');
    // The engine's own words survive, so a failure is diagnosable.
    expect(d.detail).toContain('ECONNRESET');
    // And the address is spelled out, so the page is reachable by hand when
    // shell.openExternal cannot open it.
    expect(d.detail).toContain(UPDATE_FALLBACK_URL);
  });

  it('does not claim to have opened a page it could not open', () => {
    const d = describeUpdateState({ phase: 'error', detail: 'boom', openedFallback: false });
    expect(d.headline).toBe("Couldn't update automatically.");
    expect(d.detail).toContain(UPDATE_FALLBACK_URL);
  });

  it('never points a user at GitHub, in any phase', () => {
    const phases: UpdateState['phase'][] = [
      'idle', 'checking', 'available', 'downloading', 'ready',
      'installing', 'up-to-date', 'unsupported', 'error',
    ];
    for (const phase of phases) {
      const d = describeUpdateState({ phase, version: '1.8.0', openedFallback: true });
      const text = `${d.headline} ${d.detail ?? ''}`;
      expect(text).not.toContain('github.com');
    }
  });
});

describe('shouldSurface', () => {
  it('shows nothing at all when idle', () => {
    expect(shouldSurface({ phase: 'idle' })).toBe(false);
  });

  it('reports every outcome when a person asked', () => {
    for (const phase of ['checking', 'up-to-date', 'unsupported', 'error'] as const) {
      expect(shouldSurface({ phase, interactive: true })).toBe(true);
    }
  });

  /**
   * The launch check runs unprompted eight seconds in. Someone who opened the
   * app on a train has not asked for an update, so a failure to reach GitHub
   * must not interrupt them — and must not open a browser at them either.
   */
  it('stays quiet about a background check that found nothing or failed', () => {
    expect(shouldSurface({ phase: 'checking' })).toBe(false);
    expect(shouldSurface({ phase: 'up-to-date' })).toBe(false);
    expect(shouldSurface({ phase: 'error', detail: 'offline' })).toBe(false);
  });

  it('still surfaces an offer, and its progress, from a background check', () => {
    for (const phase of ['available', 'downloading', 'ready', 'installing'] as const) {
      expect(shouldSurface({ phase })).toBe(true);
    }
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir = '';

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? userDataDir : join(userDataDir, 'downloads')),
  },
}));

const { PersistenceGateway } = await import('./persistence');

function writeStoredSettings(contents: Record<string, unknown>): void {
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify(contents), 'utf-8');
}

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'streamdock-persistence-'));
});

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true });
});

describe('background default on upgrade', () => {
  it('uses the site gradient for a fresh install with no settings file', () => {
    expect(new PersistenceGateway().getSettings().backgroundMode).toBe('gradient');
  });

  it('uses the site gradient when the stored file predates the setting', () => {
    writeStoredSettings({ downloadDir: 'D:/Videos', maxConcurrent: 5 });
    expect(new PersistenceGateway().getSettings().backgroundMode).toBe('gradient');
  });

  /**
   * `updateSettings` persists the whole merged object, so changing any
   * unrelated setting also wrote the old default `backgroundMode: 'solid'` to
   * disk. A stored 'solid' is therefore not evidence the user chose it — but
   * 'solid' *together with* the old default colour only ever occurs on a
   * background nobody touched, because that colour was never a preset.
   */
  it('adopts the gradient when solid was only ever the untouched old default', () => {
    writeStoredSettings({ downloadDir: 'D:/Videos', backgroundMode: 'solid', solidColorBg: '#0b1014' });
    expect(new PersistenceGateway().getSettings().backgroundMode).toBe('gradient');
  });

  it('respects a solid background the user actually picked a colour for', () => {
    writeStoredSettings({ downloadDir: 'D:/Videos', backgroundMode: 'solid', solidColorBg: '#3b0764' });
    const settings = new PersistenceGateway().getSettings();
    expect(settings.backgroundMode).toBe('solid');
    expect(settings.solidColorBg).toBe('#3b0764');
  });

  it.each(['bing', 'picsum', 'theme'] as const)('respects a stored %s background', (mode) => {
    writeStoredSettings({ downloadDir: 'D:/Videos', backgroundMode: mode });
    expect(new PersistenceGateway().getSettings().backgroundMode).toBe(mode);
  });

  it('keeps a stored theme id alongside the theme mode', () => {
    writeStoredSettings({ downloadDir: 'D:/Videos', backgroundMode: 'theme', backgroundTheme: 'cyborg' });
    const settings = new PersistenceGateway().getSettings();
    expect(settings.backgroundMode).toBe('theme');
    expect(settings.backgroundTheme).toBe('cyborg');
  });

  it('does not rewrite the stored file just by reading it', () => {
    writeStoredSettings({ downloadDir: 'D:/Videos', backgroundMode: 'solid', solidColorBg: '#0b1014' });
    const gateway = new PersistenceGateway();
    expect(gateway.getSettings().backgroundMode).toBe('gradient');
    // The migration is applied on read, so a user who later picks solid again
    // is not fighting a value that was silently persisted behind them.
    expect(gateway.getSettings().backgroundMode).toBe('gradient');
  });

  it('persists an explicit choice and stops migrating afterwards', () => {
    writeStoredSettings({ downloadDir: 'D:/Videos', backgroundMode: 'solid', solidColorBg: '#0b1014' });
    const gateway = new PersistenceGateway();
    gateway.updateSettings({ backgroundMode: 'solid', solidColorBg: '#1a2a4a' });
    expect(gateway.getSettings().backgroundMode).toBe('solid');
  });

  it('falls back cleanly when the settings file is corrupt', () => {
    writeFileSync(join(userDataDir, 'settings.json'), '{ not json', 'utf-8');
    expect(new PersistenceGateway().getSettings().backgroundMode).toBe('gradient');
  });
});

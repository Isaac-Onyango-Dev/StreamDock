import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * 'gradient' is the install site's own gradient and the app default;
 * 'theme' selects one of the ambient themes named by `backgroundTheme`.
 */
export type BackgroundMode = 'solid' | 'bing' | 'picsum' | 'gradient' | 'theme';

/**
 * The solid colour the app shipped as its default before the site gradient
 * replaced it. Retained only so a never-customised background can be told
 * apart from a deliberately chosen one — see `getSettings()`.
 */
const LEGACY_DEFAULT_SOLID_BG = '#0b1014';

export interface AppSettings {
  downloadDir: string;
  useCookies?: boolean;
  maxConcurrent?: number;
  scheduledStartTime?: string | null;
  hasOnboarded?: boolean;
  densityMode?: 'comfortable' | 'compact';
  backgroundMode?: BackgroundMode;
  backgroundImageUrl?: string;
  solidColorBg?: string;
  /** Ambient theme id, used when backgroundMode is 'theme'. */
  backgroundTheme?: string;
  bingRefreshInterval?: number;
  clipboardWatcher?: boolean;
  ytdlpOptions?: {
    embedSubs?: boolean;
    embedMetadata?: boolean;
    sponsorBlock?: boolean;
    customArgs?: string;
  };
}

export class PersistenceGateway {
  private path: string;
  private fallback: AppSettings;

  constructor() {
    this.path = join(app.getPath('userData'), 'settings.json');
    this.fallback = {
      downloadDir: app.getPath('downloads'),
      maxConcurrent: 3,
      hasOnboarded: false,
      densityMode: 'comfortable',
      // The site's gradient is the product's default look; a fresh install
      // should look like the thing it was downloaded from.
      backgroundMode: 'gradient',
      solidColorBg: LEGACY_DEFAULT_SOLID_BG,
      bingRefreshInterval: 1440,
      clipboardWatcher: true,
      ytdlpOptions: {
        embedSubs: true,
        embedMetadata: true,
        sponsorBlock: false,
        customArgs: '',
      },
    };
  }

  public getSettings(): AppSettings {
    try {
      if (!existsSync(this.path)) return this.fallback;
      const stored = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<AppSettings>;
      return this.applyBackgroundDefault({ ...this.fallback, ...stored }, stored);
    } catch {
      return this.fallback;
    }
  }

  /**
   * Adopt the new gradient default without overwriting a chosen background.
   *
   * `updateSettings` persists the whole merged object, so changing any unrelated
   * setting also wrote `backgroundMode: 'solid'` to disk. That means a stored
   * 'solid' is not by itself evidence the user picked it, and there is no
   * history to consult after the fact.
   *
   * What is decisive is the pair: the old default mode together with the old
   * default colour. That colour was never offered by the picker's presets, so
   * reaching it deliberately is not realistically possible — the combination
   * only occurs on a background nobody ever touched. Anything else (another
   * mode, or any other colour) is treated as a real preference and left alone.
   */
  private applyBackgroundDefault(merged: AppSettings, stored: Partial<AppSettings>): AppSettings {
    if (stored.backgroundMode === undefined) return merged;

    const untouched =
      stored.backgroundMode === 'solid' &&
      (stored.solidColorBg === undefined || stored.solidColorBg === LEGACY_DEFAULT_SOLID_BG);

    return untouched ? { ...merged, backgroundMode: 'gradient' } : merged;
  }

  public updateSettings(updates: Partial<AppSettings>): AppSettings {
    const current = this.getSettings();
    const next = { ...current, ...updates };
    
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    
    writeFileSync(this.path, JSON.stringify(next, null, 2), 'utf-8');
    return next;
  }
}

export const persistence = new PersistenceGateway();

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export interface AppSettings {
  downloadDir: string;
  useCookies?: boolean;
  maxConcurrent?: number;
  scheduledStartTime?: string | null;
  hasOnboarded?: boolean;
  densityMode?: 'comfortable' | 'compact';
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
    };
  }

  public getSettings(): AppSettings {
    try {
      if (!existsSync(this.path)) return this.fallback;
      return { ...this.fallback, ...JSON.parse(readFileSync(this.path, 'utf-8')) };
    } catch {
      return this.fallback;
    }
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

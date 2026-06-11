// Role: JSON-based persistence for download records across app restarts.
// Uses atomic writes (write to .tmp, rename to final) for safety.
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import log from 'electron-log';
import type { DownloadRecord } from './download-engine';
import type { DownloadRequest } from './download-engine';

interface PersistedState {
  records: DownloadRecord[];
  requests: Array<{ id: string; request: DownloadRequest }>;
  version: number;
}

const STATE_VERSION = 2;

export class StateStore {
  private readonly statePath: string;
  private readonly tmpPath: string;

  constructor() {
    const dir = app.getPath('userData');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.statePath = join(dir, 'downloads-state.json');
    this.tmpPath = join(dir, 'downloads-state.tmp.json');
  }

  /** Load persisted state. Returns empty state on any error. */
  load(): { records: DownloadRecord[]; requests: Map<string, DownloadRequest> } {
    try {
      if (!existsSync(this.statePath)) {
        return { records: [], requests: new Map() };
      }
      const raw = readFileSync(this.statePath, 'utf-8');
      const state: PersistedState = JSON.parse(raw);

      if (state.version !== STATE_VERSION) {
        log.warn('[state-store] State version mismatch, starting fresh');
        return { records: [], requests: new Map() };
      }

      // On load: any "running" download becomes "paused" (process died during restart)
      const records = state.records.map((r) => {
        if (r.status === 'running') {
          log.info(`[state-store] Download ${r.id} was running, marking as paused on restart`);
          return { ...r, status: 'paused' as const, speed: '', eta: '' };
        }
        return r;
      });

      const requests = new Map<string, DownloadRequest>(
        state.requests.map(({ id, request }) => [id, request]),
      );

      log.info(`[state-store] Loaded ${records.length} records, ${requests.size} saved requests`);
      return { records, requests };
    } catch (err) {
      log.error('[state-store] Failed to load state:', err);
      return { records: [], requests: new Map() };
    }
  }

  /** Atomically save state. Write to .tmp, then rename to final. */
  save(records: DownloadRecord[], requests: Map<string, DownloadRequest>): void {
    try {
      const state: PersistedState = {
        version: STATE_VERSION,
        records: records.filter((r) =>
          // Don't persist cancelled records or very old completed ones
          r.status !== 'cancelled'
        ),
        requests: Array.from(requests.entries())
          .filter(([id]) => records.some((r) => r.id === id))
          .map(([id, request]) => ({ id, request })),
      };

      const json = JSON.stringify(state, null, 2);
      // Atomic write: .tmp → rename → final (prevents corruption on crash)
      writeFileSync(this.tmpPath, json, 'utf-8');
      renameSync(this.tmpPath, this.statePath);
    } catch (err) {
      log.error('[state-store] Failed to save state:', err);
    }
  }

  /** Clear all persisted state. */
  clear(): void {
    try {
      if (existsSync(this.statePath)) {
        writeFileSync(this.statePath, JSON.stringify({ version: STATE_VERSION, records: [], requests: [] }), 'utf-8');
      }
    } catch (err) {
      log.error('[state-store] Failed to clear state:', err);
    }
  }
}

import { DownloadRecord } from '../lib/types';

export type StoreEvent = 
  | { type: 'recordAdded'; record: DownloadRecord }
  | { type: 'recordUpdated'; record: DownloadRecord }
  | { type: 'recordRemoved'; id: string }
  | { type: 'activeCountChanged'; count: number }
  | { type: 'downloadComplete'; record: DownloadRecord }
  | { type: 'stateChanged' }; // Fired on any mutation for React hooks to re-render

export type ConfirmationRequest = {
  id: string;
  title: string;
  message: string;
  actionLabel: string;
  isDestructive: boolean;
  resolve: (confirmed: boolean) => void;
};

type Listener = (event: StoreEvent) => void;

const ACTIVE_STATUSES = new Set<DownloadRecord['status']>(['scheduled', 'queued', 'resolving', 'running', 'paused']);

function isActiveStatus(status: DownloadRecord['status']): boolean {
  return ACTIVE_STATUSES.has(status);
}

class DownloadStore {
  private records: Map<string, DownloadRecord> = new Map();
  /**
   * Ids the engine has deleted. A progress event already in flight when a row
   * was removed would otherwise re-add it — an unknown id reads as a new
   * download — which is the shape of the Purge History resurrection.
   */
  private removedIds: Set<string> = new Set();
  private listeners: Set<Listener> = new Set();
  private initialized = false;
  
  // Cache for getRecords to prevent useSyncExternalStore infinite loops
  private cachedRecordsArray: DownloadRecord[] | null = null;
  
  // State for OverlayBus
  public confirmationState: ConfirmationRequest | null = null;
  public toastQueue: Array<{ id: string; message: string; type: 'success' | 'error' | 'info' }> = [];

  constructor() {
    this.setupIpcListeners();
  }

  private setupIpcListeners() {
    // We defer IPC registration until app mounts to avoid undefined streamDock in SSR/early load
  }

  public init() {
    if (typeof window === 'undefined' || !window.streamDock || this.initialized) return;
    this.initialized = true;

    window.streamDock.listDownloads().then((items) => {
      items.forEach(item => this.records.set(item.id, item));
      this.cachedRecordsArray = null;
      this.emit({ type: 'stateChanged' });
      this.updateActiveCount();
    });

    window.streamDock.onDownloadProgress((record) => {
      if (this.removedIds.has(record.id)) return;
      const isNew = !this.records.has(record.id);
      this.records.set(record.id, record);
      this.cachedRecordsArray = null;
      this.emit(isNew ? { type: 'recordAdded', record } : { type: 'recordUpdated', record });
      this.emit({ type: 'stateChanged' });
      this.updateActiveCount();
    });

    window.streamDock.onDownloadComplete((record) => {
      this.records.set(record.id, record);
      this.cachedRecordsArray = null;
      this.emit({ type: 'recordUpdated', record });
      this.emit({ type: 'downloadComplete', record });
      this.emit({ type: 'stateChanged' });
      this.updateActiveCount();
      
      this.addToast(`Downloaded: ${record.title}`, 'success');
    });

    window.streamDock.onDownloadRemoved?.((ids) => this.forget(ids));

    window.streamDock.onDownloadError((record) => {
      this.records.set(record.id, record);
      this.cachedRecordsArray = null;
      this.emit({ type: 'recordUpdated', record });
      this.emit({ type: 'stateChanged' });
      this.updateActiveCount();
      
      this.addToast(`Failed: ${record.error || 'Unknown error'}`, 'error');
    });
  }

  // --- Read API ---
  public getRecords(): DownloadRecord[] {
    if (!this.cachedRecordsArray) {
      this.cachedRecordsArray = Array.from(this.records.values());
    }
    return this.cachedRecordsArray;
  }

  public getActiveCount(): number {
    return Array.from(this.records.values()).filter((r) => isActiveStatus(r.status)).length;
  }

  // --- Write API ---
  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: StoreEvent) {
    this.listeners.forEach(l => l(event));
  }

  private updateActiveCount() {
    const count = this.getActiveCount();
    this.emit({ type: 'activeCountChanged', count });
    window.streamDock?.updateActiveCount?.(count);
  }

  // --- Destructive Actions (Gated) ---
  public async requestConfirmation(title: string, message: string, actionLabel: string, isDestructive = true): Promise<boolean> {
    return new Promise((resolve) => {
      this.confirmationState = {
        id: crypto.randomUUID(),
        title,
        message,
        actionLabel,
        isDestructive,
        resolve: (confirmed: boolean) => {
          this.confirmationState = null;
          this.emit({ type: 'stateChanged' });
          resolve(confirmed);
        }
      };
      this.emit({ type: 'stateChanged' });
    });
  }

  public async cancelDownload(id: string) {
    const record = this.records.get(id);
    if (!record) return;
    
    if (record.status !== 'completed' && record.status !== 'failed' && record.status !== 'cancelled') {
      const confirmed = await this.requestConfirmation(
        'Cancel Download?',
        `Are you sure you want to cancel "${record.title}"?`,
        'Cancel Download'
      );
      if (!confirmed) return;
    }
    
    await window.streamDock?.cancelDownload(id);
  }

  /**
   * Remove one download. The engine deletes it; the row goes only once the
   * engine says so. This used to delete the row locally after a cancel that
   * was a no-op for finished downloads, so the engine kept the record and it
   * came back on the next launch.
   */
  public async removeRecord(id: string) {
    const record = this.records.get(id);
    if (record && isActiveStatus(record.status)) {
       const confirmed = await this.requestConfirmation(
        'Cancel and Remove?',
        `This download is currently active. Are you sure you want to cancel and remove it?`,
        'Cancel & Remove'
      );
      if (!confirmed) return;
    }

    if (await window.streamDock?.removeDownload(id)) this.forget([id]);
  }

  /**
   * Clear finished rows. Only completed, failed and cancelled downloads are
   * removed — by the engine — and the list is then reloaded from it, so what
   * remains on screen is exactly what the engine still owns.
   *
   * The old version promised to "cancel N active downloads", cancelled none,
   * and cleared every row locally anyway. The engine kept those jobs running,
   * and their next progress event (Pause All emits one for each) put them back.
   */
  public async clearRecords(scope: 'all' | 'completed' | 'failed' | 'cancelled') {
    const before = new Set(this.records.keys());
    await window.streamDock?.clearEngineRecords(scope);
    const remaining = (await window.streamDock?.listDownloads()) ?? [];
    const kept = new Set(remaining.map((r) => r.id));
    this.forget([...before].filter((id) => !kept.has(id)));
  }

  private forget(ids: string[]) {
    if (ids.length === 0) return;
    for (const id of ids) {
      this.removedIds.add(id);
      this.records.delete(id);
      this.emit({ type: 'recordRemoved', id });
    }
    this.cachedRecordsArray = null;
    this.emit({ type: 'stateChanged' });
    this.updateActiveCount();
  }

  // --- Toasts ---
  public addToast(message: string, type: 'success' | 'error' | 'info' = 'info') {
    const id = crypto.randomUUID();
    this.toastQueue.push({ id, message, type });
    this.emit({ type: 'stateChanged' });
    
    setTimeout(() => {
      this.toastQueue = this.toastQueue.filter(t => t.id !== id);
      this.emit({ type: 'stateChanged' });
    }, 5000);
  }
}

export const downloadStore = new DownloadStore();

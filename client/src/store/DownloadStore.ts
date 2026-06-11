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

const ACTIVE_STATUSES = new Set<DownloadRecord['status']>(['running', 'queued', 'retrying', 'paused']);

function isActiveStatus(status: DownloadRecord['status']): boolean {
  return ACTIVE_STATUSES.has(status);
}

class DownloadStore {
  private records: Map<string, DownloadRecord> = new Map();
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

    await window.streamDock?.cancelDownload(id);
    this.records.delete(id);
    this.cachedRecordsArray = null;
    this.emit({ type: 'recordRemoved', id });
    this.emit({ type: 'stateChanged' });
    this.updateActiveCount();
  }

  public async clearRecords(scope: 'all' | 'completed' | 'failed') {
    if (scope === 'all') {
      const active = this.getActiveCount();
      if (active > 0) {
        const confirmed = await this.requestConfirmation(
          'Clear All Records?',
          `This will cancel ${active} active downloads. Proceed?`,
          'Clear All'
        );
        if (!confirmed) return;
      }
    }

    await window.streamDock?.clearEngineRecords(scope);
    
    if (scope === 'all') {
      this.records.clear();
    } else {
      Array.from(this.records.values()).forEach(r => {
        if (r.status === scope) this.records.delete(r.id);
      });
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

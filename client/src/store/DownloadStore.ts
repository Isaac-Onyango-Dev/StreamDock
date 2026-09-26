import type { DownloadRecord } from '../lib/types';

export type ConfirmationRequest = {
  id: string;
  title: string;
  message: string;
  actionLabel: string;
  isDestructive: boolean;
  resolve: (confirmed: boolean) => void;
};

type Toast = { id: string; message: string; type: 'success' | 'error' | 'info' };
type Listener = () => void;

const ACTIVE_STATUSES = new Set<DownloadRecord['status']>(['scheduled', 'queued', 'resolving', 'running', 'paused']);
/** Toasts on screen at once; a batch finishing should not bury the window in them. */
const MAX_TOASTS = 3;
const TOAST_MS = 5_000;

function isActiveStatus(status: DownloadRecord['status']): boolean {
  return ACTIVE_STATUSES.has(status);
}

/**
 * The renderer's view of the engine's downloads — a projection, never an owner.
 *
 * It applies what the engine reports and nothing else: rows leave only when the
 * engine says it removed them, and an event is applied only if it is newer
 * (by `revision`) than what the store already holds. This store used to delete
 * rows the engine still owned and re-add any id a late event mentioned, which
 * is the whole of the Purge History resurrection.
 */
class DownloadStore {
  private records: Map<string, DownloadRecord> = new Map();
  /**
   * Ids the engine has deleted. A progress event already in flight when a row
   * was removed would otherwise re-add it — an unknown id reads as a new
   * download.
   */
  private removedIds: Set<string> = new Set();
  private listeners: Set<Listener> = new Set();
  private initialized = false;

  /** Stable snapshots for useSyncExternalStore: replaced only when something changed. */
  private recordsSnapshot: DownloadRecord[] = [];
  private activeCount = 0;

  // State for OverlayBus
  public confirmationState: ConfirmationRequest | null = null;
  public toastQueue: Toast[] = [];

  public init() {
    if (typeof window === 'undefined' || !window.streamDock || this.initialized) return;
    this.initialized = true;

    // Subscribe before asking for the snapshot, so nothing that happens in
    // between is missed; revisions settle any overlap either way.
    window.streamDock.onDownloadProgress((record) => this.apply([record]));
    window.streamDock.onDownloadComplete((record) => {
      this.apply([record]);
      this.addToast(`Downloaded: ${record.title}`, 'success');
    });
    window.streamDock.onDownloadError((record) => {
      this.apply([record]);
      this.addToast(`Failed: ${record.error || 'Unknown error'}`, 'error');
    });
    window.streamDock.onDownloadRemoved?.((ids) => this.forget(ids));
    void window.streamDock.listDownloads().then((items) => this.apply(items));
  }

  // --- Read API ---
  public getRecords(): DownloadRecord[] {
    return this.recordsSnapshot;
  }

  public getActiveCount(): number {
    return this.activeCount;
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- Applying engine state ---

  private apply(incoming: DownloadRecord[]) {
    let changed = false;
    for (const record of incoming) {
      if (this.removedIds.has(record.id)) continue;
      const held = this.records.get(record.id);
      if (held && held.revision > record.revision) continue;
      this.records.set(record.id, record);
      changed = true;
    }
    if (changed) this.recordsChanged();
  }

  private forget(ids: string[]) {
    let changed = false;
    for (const id of ids) {
      this.removedIds.add(id);
      changed = this.records.delete(id) || changed;
    }
    if (changed) this.recordsChanged();
  }

  private recordsChanged() {
    this.recordsSnapshot = Array.from(this.records.values());
    this.activeCount = this.recordsSnapshot.filter((r) => isActiveStatus(r.status)).length;
    this.notify();
  }

  private notify() {
    this.listeners.forEach((l) => l());
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
          this.notify();
          resolve(confirmed);
        },
      };
      this.notify();
    });
  }

  public async cancelDownload(id: string) {
    const record = this.records.get(id);
    if (!record) return;

    if (record.status !== 'completed' && record.status !== 'failed' && record.status !== 'cancelled') {
      const confirmed = await this.requestConfirmation(
        'Cancel Download?',
        `Are you sure you want to cancel "${record.title}"?`,
        'Cancel Download',
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
        'This download is currently active. Are you sure you want to cancel and remove it?',
        'Cancel & Remove',
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

  // --- Toasts ---

  /**
   * Show a toast. The queue is replaced, never mutated: useSyncExternalStore
   * compares snapshots by identity, so a pushed-onto array looked unchanged and
   * a new toast appeared only when something unrelated re-rendered. Capped and
   * de-duplicated, because a failing batch used to stack one per error line.
   */
  public addToast(message: string, type: Toast['type'] = 'info') {
    if (this.toastQueue.some((t) => t.message === message)) return;
    const id = crypto.randomUUID();
    this.toastQueue = [...this.toastQueue, { id, message, type }].slice(-MAX_TOASTS);
    this.notify();

    setTimeout(() => {
      this.toastQueue = this.toastQueue.filter((t) => t.id !== id);
      this.notify();
    }, TOAST_MS);
  }
}

export const downloadStore = new DownloadStore();

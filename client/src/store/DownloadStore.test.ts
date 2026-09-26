// The renderer's download list against a fake engine bridge.
//
// `it.fails` marks a known defect from the session-22 audit (see
// electron/download-engine.test.ts for the convention).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadRecord } from '../lib/types';

function record(id: string, status: DownloadRecord['status'], revision = 1): DownloadRecord {
  return {
    id,
    revision,
    url: `https://www.youtube.com/watch?v=${id}`,
    mode: 'video',
    title: id,
    status,
    progress: status === 'completed' ? 100 : 40,
    speed: '',
    eta: '',
    createdAt: '2026-09-26T12:00:00.000Z',
    priority: 100,
    bytesDownloaded: 0,
    bytesTotal: 0,
  };
}

let emitProgress: (r: DownloadRecord) => void = () => undefined;

async function freshStore(engineRecords: DownloadRecord[]) {
  vi.resetModules();
  // A minimal engine: clearing drops terminal records, listing returns the rest.
  let engineState = [...engineRecords];
  const bridge = {
    listDownloads: vi.fn(async () => engineState),
    clearEngineRecords: vi.fn(async () => {
      engineState = engineState.filter((r) => !['completed', 'failed', 'cancelled'].includes(r.status));
      return true;
    }),
    removeDownload: vi.fn(async (id: string) => {
      engineState = engineState.filter((r) => r.id !== id);
      return true;
    }),
    onDownloadRemoved: vi.fn(() => () => undefined),
    onDownloadProgress: vi.fn((fn: (r: DownloadRecord) => void) => {
      emitProgress = fn;
      return () => undefined;
    }),
    onDownloadComplete: vi.fn(() => () => undefined),
    onDownloadError: vi.fn(() => () => undefined),
    cancelDownload: vi.fn(async () => true),
  };
  (window as unknown as { streamDock: unknown }).streamDock = bridge;
  const { downloadStore } = await import('./DownloadStore');
  downloadStore.init();
  await vi.waitFor(() => expect(downloadStore.getRecords()).toHaveLength(engineRecords.length));
  return { store: downloadStore, bridge };
}

const ids = (store: { getRecords: () => DownloadRecord[] }) => store.getRecords().map((r) => r.id).sort();

describe('download list', () => {
  beforeEach(() => {
    emitProgress = () => undefined;
  });

  it('shows what the engine reports on load', async () => {
    const { store } = await freshStore([record('a', 'running'), record('b', 'completed')]);
    expect(ids(store)).toEqual(['a', 'b']);
  });

  it('applies progress for a known download', async () => {
    const { store } = await freshStore([record('a', 'running')]);
    emitProgress({ ...record('a', 'running'), progress: 80 });
    expect(store.getRecords()[0].progress).toBe(80);
  });

  // Purge history hid every row, including jobs the engine kept running, so the
  // next progress event — Pause All emits one for every active job — put them
  // back. What the list shows after a clear must be what the engine still owns.
  it('clearing history does not resurrect rows on the next progress event', async () => {
    const { store } = await freshStore([record('a', 'running'), record('b', 'completed')]);
    await store.clearRecords('all');
    const afterClear = ids(store);
    expect(afterClear).toEqual(['a']);

    emitProgress(record('a', 'paused'));
    expect(ids(store)).toEqual(afterClear);
  });

  it('never lets an older event roll a row back', async () => {
    const { store } = await freshStore([record('a', 'running', 5)]);
    emitProgress({ ...record('a', 'completed', 7), progress: 100 });
    emitProgress({ ...record('a', 'running', 6), progress: 90 });
    expect(store.getRecords()[0].status).toBe('completed');
  });

  it('shows a new toast without waiting for an unrelated re-render, capped and de-duplicated', async () => {
    const { store } = await freshStore([]);
    const before = store.toastQueue;
    store.addToast('one');
    expect(store.toastQueue).not.toBe(before);
    store.addToast('one');
    for (const m of ['two', 'three', 'four']) store.addToast(m);
    expect(store.toastQueue.map((t) => t.message)).toEqual(['two', 'three', 'four']);
  });

  it('removing a finished row goes through the engine, and a late event cannot bring it back', async () => {
    const { store, bridge } = await freshStore([record('a', 'running'), record('b', 'completed')]);
    await store.removeRecord('b');
    expect(bridge.removeDownload).toHaveBeenCalledWith('b');
    expect(ids(store)).toEqual(['a']);

    emitProgress(record('b', 'completed'));
    expect(ids(store)).toEqual(['a']);
  });
});

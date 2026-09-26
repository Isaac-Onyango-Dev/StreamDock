// The renderer's download list against a fake engine bridge.
//
// `it.fails` marks a known defect from the session-22 audit (see
// electron/download-engine.test.ts for the convention).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadRecord } from '../lib/types';

function record(id: string, status: DownloadRecord['status']): DownloadRecord {
  return {
    id,
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
  const bridge = {
    listDownloads: vi.fn(async () => engineRecords),
    onDownloadProgress: vi.fn((fn: (r: DownloadRecord) => void) => {
      emitProgress = fn;
      return () => undefined;
    }),
    onDownloadComplete: vi.fn(() => () => undefined),
    onDownloadError: vi.fn(() => () => undefined),
    updateActiveCount: vi.fn(),
    clearEngineRecords: vi.fn(async () => true),
    cancelDownload: vi.fn(async () => true),
  };
  (window as unknown as { streamDock: unknown }).streamDock = bridge;
  const { downloadStore } = await import('./DownloadStore');
  downloadStore.init();
  await vi.waitFor(() => expect(downloadStore.getRecords()).toHaveLength(engineRecords.length));
  return { store: downloadStore, bridge };
}

/** Answer the confirmation dialog the way a user clicking the action would. */
async function confirm(store: { confirmationState: { resolve: (ok: boolean) => void } | null }) {
  await vi.waitFor(() => expect(store.confirmationState).not.toBeNull());
  store.confirmationState!.resolve(true);
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
  it.fails('clearing history does not resurrect rows on the next progress event', async () => {
    const { store } = await freshStore([record('a', 'running'), record('b', 'completed')]);
    const clearing = store.clearRecords('all');
    await confirm(store);
    await clearing;
    const afterClear = ids(store);

    emitProgress(record('a', 'paused'));
    expect(ids(store)).toEqual(afterClear);
  });
});

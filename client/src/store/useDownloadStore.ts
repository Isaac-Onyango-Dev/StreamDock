import { useSyncExternalStore } from 'react';
import { downloadStore } from './DownloadStore';
import type { DownloadRecord } from '../lib/types';

export function useDownloadRecords(): DownloadRecord[] {
  return useSyncExternalStore(
    (onStoreChange) => downloadStore.subscribe((e) => {
      if (e.type === 'stateChanged') onStoreChange();
    }),
    () => downloadStore.getRecords()
  );
}

export function useActiveCount(): number {
  return useSyncExternalStore(
    (onStoreChange) => downloadStore.subscribe((e) => {
      if (e.type === 'stateChanged') onStoreChange();
    }),
    () => downloadStore.getActiveCount()
  );
}

export function useConfirmationState() {
  return useSyncExternalStore(
    (onStoreChange) => downloadStore.subscribe((e) => {
      if (e.type === 'stateChanged') onStoreChange();
    }),
    () => downloadStore.confirmationState
  );
}

export function useToasts() {
  return useSyncExternalStore(
    (onStoreChange) => downloadStore.subscribe((e) => {
      if (e.type === 'stateChanged') onStoreChange();
    }),
    () => downloadStore.toastQueue
  );
}

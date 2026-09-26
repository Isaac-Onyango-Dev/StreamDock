import { useSyncExternalStore } from 'react';
import { downloadStore } from './DownloadStore';
import type { DownloadRecord } from '../lib/types';

const subscribe = (onStoreChange: () => void) => downloadStore.subscribe(onStoreChange);

/**
 * The download list. Subscribe to this only where the list is drawn: a
 * component using it re-renders on every progress event, which is why App —
 * and with it the whole Capture view — used to re-render several times a
 * second while anything was downloading.
 */
export function useDownloadRecords(): DownloadRecord[] {
  return useSyncExternalStore(subscribe, () => downloadStore.getRecords());
}

/** Unfinished downloads. A number, so it re-renders only when the count changes. */
export function useActiveCount(): number {
  return useSyncExternalStore(subscribe, () => downloadStore.getActiveCount());
}

export function useConfirmationState() {
  return useSyncExternalStore(subscribe, () => downloadStore.confirmationState);
}

export function useToasts() {
  return useSyncExternalStore(subscribe, () => downloadStore.toastQueue);
}

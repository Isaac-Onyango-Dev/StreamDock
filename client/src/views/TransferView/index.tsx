import { Download, LayoutGrid, List, Pause, Play, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { ProgressRow } from '../../components/ProgressRow';
import { useDownloadRecords } from '../../store/useDownloadStore';

interface TransferViewProps {
  density?: DensityMode;
  onDensityChange?: (mode: DensityMode) => void;
  onCancel: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRetry: (id: string) => void;
  onOpenFile: (path: string) => void;
  onShowFolder: (path: string) => void;
  onClearAll: () => void;
  onClearCompleted: () => void;
  onClearFailed: () => void;
  onRemoveItem: (id: string) => void;
  onPauseAll: () => void;
  onResumeAll: () => void;
}

type DensityMode = 'comfortable' | 'compact';

export function TransferView({
  density = 'comfortable',
  onDensityChange,
  onCancel,
  onPause,
  onResume,
  onRetry,
  onOpenFile,
  onShowFolder,
  onClearAll,
  onClearCompleted,
  onClearFailed,
  onRemoveItem,
  onPauseAll,
  onResumeAll,
}: TransferViewProps) {
  const items = useDownloadRecords();

  // Rows present when the tab opens appear at once; only rows that arrive
  // afterwards animate in. The entrance used to be delayed by 20ms per *index*,
  // so row 50 was invisible for a second and row 300 for six — and every row
  // scrolled back into view replayed it.
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(items.map((i) => i.id));
  useEffect(() => {
    for (const item of items) seen.current!.add(item.id);
  }, [items]);

  const hasCompleted = useMemo(() => items.some((i) => i.status === 'completed'), [items]);
  const hasFailed = useMemo(() => items.some((i) => i.status === 'failed'), [items]);
  const hasActive = useMemo(() => items.some((i) => ['scheduled', 'queued', 'resolving', 'running'].includes(i.status)), [items]);
  const hasPaused = useMemo(() => items.some((i) => i.status === 'paused'), [items]);
  const hasCancelled = useMemo(() => items.some((i) => i.status === 'cancelled'), [items]);
  // Position in the queue, looked up per row: a map built once per render. A
  // findIndex per queued row made every progress event quadratic in the queue.
  const queuePositions = useMemo(() => {
    const positions = new Map<string, number>();
    for (const item of items) if (item.status === 'queued') positions.set(item.id, positions.size);
    return positions;
  }, [items]);


  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="mr-auto text-xs text-text-secondary">
          {items.length} {items.length === 1 ? 'item' : 'items'}
        </span>

        <div className="flex rounded-md border border-border bg-surface-2 p-0.5">
          <button
            type="button"
            onClick={() => onDensityChange?.('comfortable')}
            aria-pressed={density === 'comfortable'}
            title="Comfortable"
            className={`btn-icon h-6 w-6 ${density === 'comfortable' ? 'bg-surface-3 text-text-primary' : ''}`}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onDensityChange?.('compact')}
            aria-pressed={density === 'compact'}
            title="Compact"
            className={`btn-icon h-6 w-6 ${density === 'compact' ? 'bg-surface-3 text-text-primary' : ''}`}
          >
            <List className="h-3.5 w-3.5" />
          </button>
        </div>

        {hasActive && (
          <button type="button" onClick={onPauseAll} className="btn-ghost text-warning">
            <Pause className="h-3.5 w-3.5" /> Pause all
          </button>
        )}
        {hasPaused && (
          <button type="button" onClick={onResumeAll} className="btn-ghost text-accent">
            <Play className="h-3.5 w-3.5" /> Resume all
          </button>
        )}
        {hasCompleted && (
          <button type="button" onClick={onClearCompleted} className="btn-ghost">
            <Trash2 className="h-3.5 w-3.5" /> Clear done
          </button>
        )}
        {hasFailed && (
          <button type="button" onClick={onClearFailed} className="btn-ghost text-error">
            <Trash2 className="h-3.5 w-3.5" /> Clear failed
          </button>
        )}
        {(hasCompleted || hasFailed || hasCancelled) && (
          <button
            type="button"
            onClick={onClearAll}
            className="btn-ghost"
            title="Remove finished, failed and cancelled downloads from this list. Files on disk are kept; active downloads are not affected."
          >
            Clear history
          </button>
        )}
      </div>

      {/*
        A plain list of memoised rows. The hand-rolled virtualiser that was here
        assumed rows of 96px (44px compact) when a real row is ~200px and varies
        with its error and stall notes, so the scroll height changed while
        scrolling: rows jumped and the thumb resized under the pointer, and it
        switched layout mode at the 21st item. content-visibility was tried and
        rejected for the same reason in a milder form — off-screen rows are sized
        from an estimate, so the list grew as you reached the bottom. Measured in
        the production build (session 22): with 1000 rows a progress event costs
        about 1ms of work, and opening the tab takes about 1s — ~50ms for a
        53-episode queue — so windowing is not worth its bugs at this scale.
      */}
      <div className="downloads-scroll min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div
            aria-live="polite"
            className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border-subtle py-12 text-center"
          >
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-surface-2">
              <Download className="h-4 w-4 text-text-disabled" />
            </div>
            <p className="text-sm font-medium text-text-primary">No downloads yet</p>
            <p className="mt-1 max-w-xs text-xs text-text-secondary">
              Paste a URL in Capture to start downloading.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {items.map((item) => {
              const queuePosition = queuePositions.get(item.id);
              return (
                <div
                  key={item.id}
                  className={`download-row ${seen.current!.has(item.id) ? '' : 'animate-entrance-row'}`}
                >
                  <ProgressRow
                    item={item}
                    density={density}
                    onCancel={onCancel}
                    onPause={onPause}
                    onResume={onResume}
                    onRetry={onRetry}
                    onOpenFile={onOpenFile}
                    onShowFolder={onShowFolder}
                    onRemove={onRemoveItem}
                    queuePosition={queuePosition}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

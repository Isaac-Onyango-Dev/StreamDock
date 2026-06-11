import { Download, LayoutGrid, List, Pause, Play, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { DownloadRecord } from '../../lib/types';
import { ProgressRow } from '../../components/ProgressRow';

interface TransferViewProps {
  items: DownloadRecord[];
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
  items,
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const hasCompleted = useMemo(() => items.some((i) => i.status === 'completed'), [items]);
  const hasFailed = useMemo(() => items.some((i) => i.status === 'failed'), [items]);
  const hasActive = useMemo(() => items.some((i) => ['running', 'queued', 'retrying'].includes(i.status)), [items]);
  const hasPaused = useMemo(() => items.some((i) => i.status === 'paused'), [items]);
  const queueItems = useMemo(
    () => items.filter((i) => i.status === 'queued').sort((a, b) => a.priority - b.priority),
    [items],
  );

  const ITEM_HEIGHT = density === 'comfortable' ? 96 : 44;
  const GAP = 8;
  const VISIBLE_COUNT = Math.ceil(800 / (ITEM_HEIGHT + GAP)) + 5;
  const startIndex = items.length > 20 ? Math.max(0, Math.floor(scrollTop / (ITEM_HEIGHT + GAP)) - 5) : 0;
  const endIndex = items.length > 20 ? Math.min(items.length, startIndex + VISIBLE_COUNT + 10) : items.length;
  const visibleItems = items.slice(startIndex, endIndex);

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
        {items.length > 0 && (
          <button type="button" onClick={onClearAll} className="btn-ghost">
            Purge history
          </button>
        )}
      </div>

      <div
        ref={scrollRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="min-h-0 flex-1 overflow-y-auto custom-scrollbar"
      >
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
          <div
            className="relative w-full"
            style={{ height: items.length > 20 ? `${items.length * (ITEM_HEIGHT + GAP)}px` : 'auto' }}
          >
            <div
              className="absolute left-0 right-0 top-0 flex flex-col gap-2"
              style={{ transform: items.length > 20 ? `translateY(${startIndex * (ITEM_HEIGHT + GAP)}px)` : 'none' }}
            >
              {visibleItems.map((item, idx) => {
                const queuePosition = item.status === 'queued'
                  ? queueItems.findIndex((qi) => qi.id === item.id)
                  : undefined;
                return (
                  <div
                    key={item.id}
                    className="animate-entrance-row"
                    style={{ animationDelay: `${(startIndex + idx) * 20}ms`, animationFillMode: 'backwards' }}
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
          </div>
        )}
      </div>
    </section>
  );
}

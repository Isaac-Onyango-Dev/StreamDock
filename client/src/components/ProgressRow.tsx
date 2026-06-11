import {
  AlertTriangle,
  ChevronRight,
  ExternalLink,
  FolderOpen,
  MoreHorizontal,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Square,
  Video,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { formatBytes, formatPercent, formatTime, shortDate } from '../lib/format';
import type { DownloadRecord } from '../lib/types';

interface ProgressRowProps {
  item: DownloadRecord;
  density?: 'comfortable' | 'compact';
  onCancel: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRetry: (id: string) => void;
  onOpenFile: (path: string) => void;
  onShowFolder: (path: string) => void;
  onRemove?: (id: string) => void;
  queuePosition?: number;
}

function truncatePath(path: string | undefined) {
  if (!path) return '';
  return path.replace(/^[a-zA-Z]:\\Users\\[^\\]+\\/, '~/').replace(/^\/Users\/[^/]+\//, '~/');
}

function statusTone(status: DownloadRecord['status']) {
  switch (status) {
    case 'running':
    case 'retrying':
      return 'bg-accent-muted text-accent';
    case 'completed':
      return 'bg-success-muted text-success';
    case 'failed':
      return 'bg-error-subtle text-error';
    case 'paused':
      return 'bg-warning-muted text-warning';
    default:
      return 'bg-surface-3 text-text-secondary';
  }
}

function statusLabel(status: DownloadRecord['status']) {
  if (status === 'retrying') return 'Reconnecting';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function TechnicalDetailsModal({
  item,
  onClose,
  onShowFolder,
}: {
  item: DownloadRecord;
  onClose: () => void;
  onShowFolder: (path: string) => void;
}) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px] animate-fade-in">
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-lg border border-border bg-surface-1 shadow-3 animate-modal-enter">
        <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
          <h3 className="text-sm font-medium text-text-primary">Details</h3>
          <button type="button" onClick={onClose} className="btn-icon" aria-label="Close">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="overflow-auto p-3 text-xs">
          {item.outputPath && (
            <div className="mb-3">
              <span className="text-text-secondary">Path </span>
              <code className="break-all text-text-primary" data-selectable>{truncatePath(item.outputPath)}</code>
              <button
                type="button"
                onClick={() => onShowFolder(item.outputPath!)}
                className="ml-2 text-accent hover:underline"
              >
                Reveal
              </button>
            </div>
          )}
          {item.error && (
            <pre className="whitespace-pre-wrap rounded-md bg-error-subtle p-2 text-error" data-selectable>
              {item.error}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

export function ProgressRow({
  item,
  density = 'comfortable',
  onCancel,
  onPause,
  onResume,
  onRetry,
  onOpenFile,
  onShowFolder,
  onRemove,
  queuePosition,
}: ProgressRowProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const isRunning = item.status === 'running';
  const isPaused = item.status === 'paused';
  const isDone = item.status === 'completed';
  const isFailed = item.status === 'failed';
  const isRetrying = item.status === 'retrying';
  const isQueued = item.status === 'queued';
  const ModeIcon = item.mode === 'stream' ? Radio : Video;
  const progress = Math.max(0, Math.min(item.progress, 100));

  if (density === 'compact') {
    return (
      <>
        <div className="group flex items-center gap-2 rounded-md border border-border-subtle bg-surface-2 px-2 py-1.5 transition-colors hover:bg-surface-3">
          <div
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              isRunning || isRetrying ? 'bg-accent' : isDone ? 'bg-success' : isFailed ? 'bg-error' : 'bg-text-disabled'
            }`}
          />
          <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{item.title}</span>
          <div className="flex w-24 items-center gap-1.5">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-4">
              <div
                className={`h-full ${isDone ? 'bg-success' : isRunning ? 'bg-accent' : 'bg-border'}`}
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="w-8 text-right text-[10px] tabular-nums text-text-secondary">{formatPercent(progress)}</span>
          </div>
          <div className="relative">
            <button type="button" onClick={() => setMenuOpen(!menuOpen)} className="btn-icon h-6 w-6" aria-label="Actions">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 top-full z-50 mt-1 w-40 rounded-md border border-border bg-surface-2 p-1 shadow-2 animate-context-menu-enter">
                  {(isRunning || isRetrying) && (
                    <>
                      <button type="button" onClick={() => { onPause(item.id); setMenuOpen(false); }} className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-surface-3">Pause</button>
                      <button type="button" onClick={() => { onCancel(item.id); setMenuOpen(false); }} className="w-full rounded px-2 py-1.5 text-left text-xs text-error hover:bg-error-subtle">Cancel</button>
                    </>
                  )}
                  {isPaused && (
                    <>
                      <button type="button" onClick={() => { onResume(item.id); setMenuOpen(false); }} className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-surface-3">Resume</button>
                      <button type="button" onClick={() => { onCancel(item.id); setMenuOpen(false); }} className="w-full rounded px-2 py-1.5 text-left text-xs text-error hover:bg-error-subtle">Cancel</button>
                    </>
                  )}
                  {isDone && item.outputPath && (
                    <>
                      <button type="button" onClick={() => { onOpenFile(item.outputPath!); setMenuOpen(false); }} className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-surface-3">Open</button>
                      <button type="button" onClick={() => { onShowFolder(item.outputPath!); setMenuOpen(false); }} className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-surface-3">Show in folder</button>
                    </>
                  )}
                  {isFailed && (
                    <button type="button" onClick={() => { onRetry(item.id); setMenuOpen(false); }} className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-surface-3">Retry</button>
                  )}
                  {onRemove && (isDone || isFailed) && (
                    <button type="button" onClick={() => { onRemove(item.id); setMenuOpen(false); }} className="w-full rounded px-2 py-1.5 text-left text-xs text-error hover:bg-error-subtle">Remove</button>
                  )}
                  <button type="button" onClick={() => { setDetailsOpen(true); setMenuOpen(false); }} className="w-full rounded px-2 py-1.5 text-left text-xs text-text-secondary hover:bg-surface-3">Details</button>
                </div>
              </>
            )}
          </div>
        </div>
        {detailsOpen && (
          <TechnicalDetailsModal item={item} onClose={() => setDetailsOpen(false)} onShowFolder={onShowFolder} />
        )}
      </>
    );
  }

  return (
    <>
      <article
        className={`rounded-lg border bg-surface-2 p-2.5 transition-colors ${
          isRunning || isRetrying ? 'border-accent/30' : isFailed ? 'border-error/25' : 'border-border-subtle'
        }`}
      >
        <div className="flex items-start gap-2">
          {item.thumbnail ? (
            <img src={item.thumbnail} alt="" className="h-11 w-8 shrink-0 rounded object-cover" />
          ) : (
            <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${statusTone(item.status)}`}>
              <ModeIcon className="h-3.5 w-3.5" />
            </div>
          )}

          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h4 className="truncate text-sm font-medium text-text-primary">{item.title}</h4>
                <p className="mt-0.5 truncate text-xs text-text-secondary" data-selectable>{item.url}</p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <div className="flex items-center gap-1.5">
                  {isQueued && queuePosition !== undefined && (
                    <span className="text-[10px] text-text-disabled">#{queuePosition + 1}</span>
                  )}
                  <span className={`badge ${statusTone(item.status)}`}>{statusLabel(item.status)}</span>
                </div>
                <span className="text-[10px] tabular-nums text-text-disabled">{shortDate(item.createdAt)}</span>
              </div>
            </div>

            <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-4">
              <div
                className={`h-full rounded-full transition-all ${
                  isRunning || isRetrying ? 'bg-accent animate-progress-shimmer' : isDone ? 'bg-success' : 'bg-border'
                }`}
                style={{ width: `${progress}%` }}
              />
            </div>

            <div className="mt-1.5 flex items-center justify-between text-xs">
              <span className={`font-medium tabular-nums ${isRunning ? 'text-accent' : isDone ? 'text-success' : 'text-text-secondary'}`}>
                {formatPercent(progress)}
              </span>
              <span className="text-text-secondary">
                {isRunning ? (
                  <>
                    {item.speed || 'Starting…'}
                    {item.eta ? ` · ${formatTime(item.eta)}` : ''}
                    {item.bytesDownloaded ? ` · ${formatBytes(item.bytesDownloaded)}${item.bytesTotal ? ` / ${formatBytes(item.bytesTotal)}` : ''}` : ''}
                  </>
                ) : isDone ? (
                  item.bytesTotal ? formatBytes(item.bytesTotal) : 'Complete'
                ) : isQueued ? (
                  'Queued'
                ) : isRetrying ? (
                  'Retrying…'
                ) : null}
              </span>
            </div>

            {item.stallMessage && isRunning && (
              <div role="alert" className="mt-2 flex items-start gap-1.5 rounded-md bg-warning-muted px-2 py-1 text-xs text-warning">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                {item.stallMessage}
              </div>
            )}

            {item.error && (
              <div role="alert" className="mt-2 flex items-start gap-1.5 rounded-md bg-error-subtle px-2 py-1 text-xs text-error">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                {item.error}
              </div>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-1">
              {(isRunning || isRetrying) && (
                <>
                  <button type="button" onClick={() => onPause(item.id)} className="btn-ghost h-7 px-2 text-xs">
                    <Pause className="h-3 w-3" /> Pause
                  </button>
                  <button type="button" onClick={() => onCancel(item.id)} className="btn-danger h-7 px-2 text-xs">
                    <Square className="h-3 w-3" /> Cancel
                  </button>
                </>
              )}
              {isPaused && (
                <>
                  <button type="button" onClick={() => onResume(item.id)} className="btn-ghost h-7 px-2 text-xs text-accent">
                    <Play className="h-3 w-3 fill-current" /> Resume
                  </button>
                  <button type="button" onClick={() => onCancel(item.id)} className="btn-danger h-7 px-2 text-xs">
                    Cancel
                  </button>
                </>
              )}
              {isFailed && (
                <>
                  <button type="button" onClick={() => onRetry(item.id)} className="btn-ghost h-7 px-2 text-xs text-accent">
                    <RefreshCw className="h-3 w-3" /> Retry
                  </button>
                  {onRemove && (
                    <button type="button" onClick={() => onRemove(item.id)} className="btn-ghost h-7 px-2 text-xs">
                      Remove
                    </button>
                  )}
                </>
              )}
              {isQueued && (
                <button type="button" onClick={() => onCancel(item.id)} className="btn-danger h-7 px-2 text-xs">
                  Cancel
                </button>
              )}
              {isDone && (
                <>
                  {item.outputPath && (
                    <>
                      <button type="button" onClick={() => onOpenFile(item.outputPath!)} className="btn-ghost h-7 px-2 text-xs text-accent">
                        <ExternalLink className="h-3 w-3" /> Open
                      </button>
                      <button type="button" onClick={() => onShowFolder(item.outputPath!)} className="btn-ghost h-7 px-2 text-xs">
                        <FolderOpen className="h-3 w-3" /> Folder
                      </button>
                    </>
                  )}
                  {onRemove && (
                    <button type="button" onClick={() => onRemove(item.id)} className="btn-ghost h-7 px-2 text-xs">
                      Remove
                    </button>
                  )}
                </>
              )}
              <button
                type="button"
                onClick={() => setDetailsOpen(true)}
                className="ml-auto flex items-center gap-0.5 text-[10px] text-text-disabled hover:text-text-secondary"
              >
                <ChevronRight className="h-3 w-3" /> Details
              </button>
            </div>
          </div>
        </div>
      </article>

      {detailsOpen && (
        <TechnicalDetailsModal item={item} onClose={() => setDetailsOpen(false)} onShowFolder={onShowFolder} />
      )}
    </>
  );
}

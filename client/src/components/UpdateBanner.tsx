import { AlertCircle, ArrowDownToLine, CheckCircle2, Loader2, RefreshCw, X } from 'lucide-react';
import { describeUpdateState, shouldSurface, type UpdateState } from '../../../shared/update-state';
import { formatBytes, formatPercent } from '../lib/format';

interface UpdateBannerProps {
  state: UpdateState;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
  onDismiss: () => void;
}

const TONE_CLASSES = {
  info: 'border-accent/30 bg-accent-muted',
  progress: 'border-accent/30 bg-accent-muted',
  success: 'border-success/30 bg-success-muted',
  error: 'border-error/20 bg-error-subtle',
} as const;

/**
 * The application's update surface.
 *
 * The whole point of this component is requirement 2 of the round it was built
 * for: an update that is downloading has to *look* like it is downloading. The
 * flow used to run entirely through native dialogs, so the several minutes
 * between consenting and the installer being ready showed the user nothing at
 * all — the modal simply closed and a 300MB transfer ran in silence.
 */
export function UpdateBanner({ state, onCheck, onDownload, onInstall, onDismiss }: UpdateBannerProps) {
  if (!shouldSurface(state)) return null;

  const { headline, detail, tone } = describeUpdateState(state);
  if (!headline) return null;

  const busy = state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'installing';
  // An install has already handed control to the installer; there is nothing
  // left to dismiss and offering the control would only suggest otherwise.
  const dismissible = state.phase !== 'installing';
  const percent = state.percent ?? 0;

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
      data-update-phase={state.phase}
      className={`mb-3 flex items-start gap-2 rounded-md border px-3 py-2 ${TONE_CLASSES[tone]}`}
    >
      <span className="mt-0.5 shrink-0" aria-hidden>
        {tone === 'error' ? (
          <AlertCircle className="h-3.5 w-3.5 text-error" />
        ) : state.phase === 'ready' ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-success" />
        ) : busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
        ) : (
          <ArrowDownToLine className="h-3.5 w-3.5 text-accent" />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug text-text-primary">{headline}</p>
        {detail && (
          <p className="mt-0.5 text-xs leading-snug text-text-secondary" data-selectable>
            {detail}
          </p>
        )}

        {state.phase === 'downloading' && (
          <div className="mt-2">
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-4">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{ width: `${percent}%` }}
              />
            </div>
            {/*
              The bar alone can look stalled on a slow connection, so the
              transferred figure is spelled out beside it — it keeps moving even
              when the percentage has not ticked over yet.
            */}
            <div className="mt-1 flex items-center justify-between text-xs text-text-secondary">
              <span className="font-medium tabular-nums text-accent">{formatPercent(percent)}</span>
              <span className="tabular-nums">
                {state.transferred !== undefined && state.total
                  ? `${formatBytes(state.transferred)} of ${formatBytes(state.total)}`
                  : 'Starting…'}
                {state.bytesPerSecond ? ` · ${formatBytes(state.bytesPerSecond)}/s` : ''}
              </span>
            </div>
          </div>
        )}

        {state.phase === 'available' && (
          <button
            type="button"
            onClick={onDownload}
            className="btn-primary mt-2 h-7 px-3 text-xs"
          >
            <ArrowDownToLine className="h-3.5 w-3.5" />
            Download &amp; install
          </button>
        )}

        {state.phase === 'ready' && (
          <button type="button" onClick={onInstall} className="btn-primary mt-2 h-7 px-3 text-xs">
            <RefreshCw className="h-3.5 w-3.5" />
            Restart &amp; install
          </button>
        )}

        {/*
          Retry the step that actually failed. A failed *check* has no version
          yet, so retrying the download would just fail again on missing update
          info; a failed *download* already knows which version it wanted.
        */}
        {state.phase === 'error' && (
          <button
            type="button"
            onClick={state.version ? onDownload : onCheck}
            className="btn-secondary mt-2 h-7 px-3 text-xs"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Try again
          </button>
        )}
      </div>

      {dismissible && (
        <button
          type="button"
          onClick={onDismiss}
          className="btn-icon -mr-1 -mt-0.5 text-text-secondary"
          aria-label="Dismiss update notice"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

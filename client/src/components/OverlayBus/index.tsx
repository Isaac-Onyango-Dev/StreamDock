import { useEffect, useRef } from 'react';
import { useConfirmationState, useToasts } from '../../store/useDownloadStore';
import { CheckCircle2, AlertCircle, Info } from 'lucide-react';

type ToastType = 'success' | 'error' | 'info';

export function OverlayBus() {
  const confirmation = useConfirmationState();
  const toasts = useToasts();
  const cancelBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirmation) cancelBtnRef.current?.focus();
  }, [confirmation]);

  return (
    <>
      {confirmation && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px] animate-fade-in">
          <div
            className="w-full max-w-sm rounded-lg border border-border bg-surface-1 p-4 shadow-3 animate-modal-enter"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
          >
            <h2 id="confirm-title" className="text-md font-semibold text-text-primary">
              {confirmation.title}
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">
              {confirmation.message}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                ref={cancelBtnRef}
                type="button"
                onClick={() => confirmation.resolve(false)}
                className="btn-ghost"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => confirmation.resolve(true)}
                className={confirmation.isDestructive ? 'btn-danger' : 'btn-primary'}
              >
                {confirmation.actionLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex flex-col gap-2">
        {toasts.map((toast: { id: string; message: string; type: ToastType }) => {
          const Icon = toast.type === 'success' ? CheckCircle2 : toast.type === 'error' ? AlertCircle : Info;
          const tone =
            toast.type === 'success'
              ? 'border-success/25 bg-surface-1'
              : toast.type === 'error'
                ? 'border-error/25 bg-surface-1'
                : 'border-accent/25 bg-surface-1';

          return (
            <div
              key={toast.id}
              role="status"
              className={`pointer-events-auto flex max-w-sm items-start gap-2 rounded-md border px-3 py-2.5 shadow-2 animate-toast-enter ${tone}`}
            >
              <Icon
                className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                  toast.type === 'success' ? 'text-success' : toast.type === 'error' ? 'text-error' : 'text-accent'
                }`}
              />
              <p className="text-sm text-text-primary">{toast.message}</p>
            </div>
          );
        })}
      </div>
    </>
  );
}

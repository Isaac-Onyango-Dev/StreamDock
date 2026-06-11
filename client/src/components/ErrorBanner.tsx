import { AlertCircle, X } from 'lucide-react';

interface ErrorBannerProps {
  message: string | null;
  onDismiss: () => void;
}

export function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  if (!message) return null;

  return (
    <div
      role="alert"
      className="mb-3 flex items-start gap-2 rounded-md border border-error/20 bg-error-subtle px-3 py-2 text-error"
    >
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 text-sm leading-snug text-text-primary">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="btn-icon -mr-1 -mt-0.5 text-text-secondary hover:text-error"
        aria-label="Dismiss error"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

import { AlertTriangle, RefreshCw, X } from 'lucide-react';

interface VersionWarningBannerProps {
  message: string;
  onDismiss: () => void;
  onUpdate: () => void;
  updating: boolean;
}

export function VersionWarningBanner({ message, onDismiss, onUpdate, updating }: VersionWarningBannerProps) {
  return (
    <div
      role="status"
      className="mb-3 flex items-start gap-2 rounded-md border border-warning/30 bg-warning-muted px-3 py-2"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-text-primary">{message}</p>
        <button
          type="button"
          onClick={onUpdate}
          disabled={updating}
          className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-warning hover:underline disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${updating ? 'animate-spin' : ''}`} />
          {updating ? 'Updating…' : 'Update yt-dlp now'}
        </button>
      </div>
      <button type="button" onClick={onDismiss} className="btn-icon -mr-1 -mt-0.5" aria-label="Dismiss warning">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

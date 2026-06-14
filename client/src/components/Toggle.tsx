interface ToggleProps {
  enabled: boolean;
  onChange: (val: boolean) => void;
  label?: string;
  ariaLabel?: string;
}

export function Toggle({ enabled, onChange, label, ariaLabel }: ToggleProps) {
  return (
    <div className="flex items-center gap-3">
      {label && (
        <div className="flex-1 min-w-0">
          <p className="text-sm text-text-primary">{label}</p>
        </div>
      )}
      <button
        role="switch"
        aria-checked={enabled}
        aria-label={ariaLabel}
        onClick={() => onChange(!enabled)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 ${enabled ? 'bg-accent' : 'bg-surface-4'}`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-1 transition-transform duration-200 ${enabled ? 'translate-x-6' : 'translate-x-1'}`}
        />
      </button>
    </div>
  );
}
import { Radio, Video } from 'lucide-react';
import type { CaptureMode } from '../lib/types';

interface FlowToggleProps {
  value: CaptureMode;
  onChange: (mode: CaptureMode) => void;
}

const modes = [
  { id: 'video' as const, label: 'Video', icon: Video },
  { id: 'stream' as const, label: 'Stream', icon: Radio },
];

export function FlowToggle({ value, onChange }: FlowToggleProps) {
  return (
    <div
      className="inline-flex rounded-md border border-border bg-surface-2 p-0.5"
      role="group"
      aria-label="Capture mode"
    >
      {modes.map((mode) => {
        const Icon = mode.icon;
        const active = value === mode.id;
        return (
          <button
            key={mode.id}
            type="button"
            onClick={() => onChange(mode.id)}
            aria-pressed={active}
            className={`flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 ${
              active
                ? 'bg-surface-3 text-text-primary shadow-1'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
            {mode.label}
          </button>
        );
      })}
    </div>
  );
}

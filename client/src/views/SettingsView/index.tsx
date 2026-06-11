import { useState } from 'react';
import { CheckCircle2, FolderOpen, RefreshCw, XCircle } from 'lucide-react';
import type { EngineStatus, Settings } from '../../lib/types';

interface SettingsPanelProps {
  settings: Settings;
  engines: EngineStatus[];
  onChooseFolder: () => void;
  onSettingsChange: (s: Settings) => void;
  onEngineRefresh: () => Promise<void>;
}

export function SettingsView({
  settings,
  engines,
  onChooseFolder,
  onSettingsChange,
  onEngineRefresh,
}: SettingsPanelProps) {
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);

  const handleUpdateEngine = async () => {
    if (!window.streamDock?.updateEngine) return;
    setIsUpdating(true);
    setUpdateMessage(null);
    try {
      const res = await window.streamDock.updateEngine();
      setUpdateMessage(res.success ? (res.message || 'Updated successfully.') : `Failed: ${res.error}`);
      if (res.success) await onEngineRefresh();
    } catch (e) {
      setUpdateMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsUpdating(false);
    }
  };

  const allReady = engines.length > 0 && engines.every((e) => e.available);
  const anyMissing = engines.some((e) => !e.available);

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex items-center gap-2">
        <span
          className={`badge ${
            allReady ? 'bg-success-muted text-success' : anyMissing ? 'bg-error-subtle text-error' : 'bg-surface-3 text-text-secondary'
          }`}
        >
          {allReady ? 'Engines ready' : anyMissing ? 'Engine missing' : 'Checking…'}
        </span>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {/* Save location */}
        <section className="card card-pad">
          <h3 className="text-sm font-medium text-text-primary">Save location</h3>
          <p className="mt-0.5 text-xs text-text-secondary">Where downloaded files are stored.</p>

          <div className="mt-3 rounded-md border border-border-subtle bg-surface-3 px-2.5 py-2">
            <p
              className="break-all font-mono text-xs leading-relaxed text-text-primary data-selectable select-text"
              data-selectable
            >
              {settings.downloadDir || 'No folder selected'}
            </p>
          </div>

          <button type="button" onClick={onChooseFolder} className="btn-primary mt-3 w-full">
            <FolderOpen className="h-3.5 w-3.5" />
            Choose folder
          </button>

          <div className="mt-4 space-y-3 border-t border-border-subtle pt-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm text-text-primary">Use Chrome cookies</p>
                <p className="text-xs text-text-secondary">For age-gated or login-protected sites.</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.useCookies}
                onClick={() => {
                  void window.streamDock?.updateSettings({ useCookies: !settings.useCookies }).then((next) => {
                    if (next) onSettingsChange(next);
                  });
                }}
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 ${
                  settings.useCookies ? 'bg-accent' : 'bg-surface-4'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-1 transition-transform ${
                    settings.useCookies ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm text-text-primary">Concurrent downloads</p>
                <span className="text-xs font-medium tabular-nums text-text-secondary">
                  {settings.maxConcurrent || 3}
                </span>
              </div>
              <input
                type="range"
                min={1}
                max={10}
                step={1}
                value={settings.maxConcurrent || 3}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  void window.streamDock?.updateSettings({ maxConcurrent: val }).then((next) => {
                    if (next) onSettingsChange(next);
                  });
                }}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-4 accent-accent"
              />
            </div>
          </div>
        </section>

        {/* Engines */}
        <section className="card card-pad">
          <h3 className="text-sm font-medium text-text-primary">Engines</h3>
          <p className="mt-0.5 text-xs text-text-secondary">yt-dlp and ffmpeg binaries used for downloads.</p>

          <div className="mt-3 space-y-2">
            {engines.map((engine) => (
              <div
                key={engine.name}
                className={`rounded-md border px-3 py-2.5 ${
                  engine.available ? 'border-success/20 bg-success-muted/50' : 'border-error/20 bg-error-subtle'
                }`}
              >
                <div className="flex items-start gap-2">
                  {engine.available ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                  ) : (
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-error" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-text-primary">{engine.name}</span>
                      <span className={`text-xs ${engine.available ? 'text-success' : 'text-error'}`}>
                        {engine.available ? 'Ready' : 'Missing'}
                      </span>
                    </div>
                    <p
                      className="mt-1 break-all font-mono text-[11px] leading-snug text-text-secondary data-selectable select-text"
                      data-selectable
                    >
                      {engine.path || 'Not found in binaries/ or PATH'}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={handleUpdateEngine}
            disabled={isUpdating}
            className="btn-secondary mt-3 w-full"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isUpdating ? 'animate-spin' : ''}`} />
            {isUpdating ? 'Updating…' : 'Update yt-dlp'}
          </button>
          {updateMessage && (
            <p className="mt-2 text-center text-xs text-text-secondary" data-selectable>
              {updateMessage}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

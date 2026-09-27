import { useEffect, useState } from 'react';
import { Settings } from '../../lib/types';
import { Toggle } from '../../components/Toggle';
import { Package } from 'lucide-react';

interface YtDlpSettingsProps {
  settings: Settings;
  onSettingsChange: (s: Settings) => void;
}

interface PluginInfo {
  name: string;
  path: string;
}

/**
 * Subtitle rules by the language of the audio. Where a source serves Sub and
 * Dub as separate streams, a Sub episode is Japanese audio that needs its
 * subtitles and a Dub episode usually does not — one "default subtitles"
 * setting could not say both.
 */
const SUBTITLE_RULES = [
  { key: 'subtitleMode', label: 'Subtitles for Sub (original audio)', fallback: 'embed' },
  { key: 'subtitleModeForDub', label: 'Subtitles for Dub', fallback: 'none' },
] as const;

export function YtDlpSettings({ settings, onSettingsChange }: YtDlpSettingsProps) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [customArgs, setCustomArgs] = useState(settings.ytdlpOptions?.customArgs ?? '');

  useEffect(() => {
    // Call the PLUGINS_LIST IPC via the dedicated preload API
    const getPlugins = async () => {
      try {
        if (window.streamDock?.pluginsList) {
          const list = await window.streamDock.pluginsList();
          if (Array.isArray(list)) setPlugins(list);
        }
      } catch (e) {
        console.error('Failed to load plugins:', e);
      }
    };
    getPlugins();
  }, []);

  const updateYtdlpOption = (key: keyof NonNullable<Settings['ytdlpOptions']>, value: boolean | string) => {
    const current = settings.ytdlpOptions || {};
    const next = { ...current, [key]: value };
    void window.streamDock?.updateSettings({ ytdlpOptions: next }).then((updated) => {
      if (updated) onSettingsChange(updated);
    });
  };

  // Defaults come from the main process (persistence.ts); this only covers
  // the render before settings have loaded.
  const opts = settings.ytdlpOptions ?? {};

  return (
    <section className="card card-pad">
      <h3 className="text-sm font-medium text-text-primary">Advanced yt-dlp Options</h3>
      <p className="mt-0.5 mb-4 text-xs text-text-secondary">Configure low-level download engine behavior.</p>

      <div className="space-y-4 border-t border-border-subtle pt-3">
        <div className="grid gap-3 sm:grid-cols-2">
          {SUBTITLE_RULES.map((rule) => (
            <div key={rule.key}>
              <label htmlFor={rule.key} className="mb-1.5 block text-sm font-medium text-text-primary">
                {rule.label}
              </label>
              <select
                id={rule.key}
                className="select-field w-full"
                value={opts[rule.key] ?? rule.fallback}
                onChange={(e) => updateYtdlpOption(rule.key, e.target.value)}
              >
                <option value="none">None</option>
                <option value="sidecar">Separate file</option>
                <option value="embed">Embedded in the video</option>
                <option value="both">Both</option>
              </select>
            </div>
          ))}
          <p className="text-xs text-text-secondary sm:col-span-2">
            Each download starts from the rule for its language, and can still be changed
            on the Capture screen when the source offers subtitles.
          </p>
        </div>
        <Toggle
          label="Embed Metadata"
          ariaLabel="Embed video metadata (title, artist, etc) in output file"
          enabled={opts.embedMetadata ?? true}
          onChange={(val) => updateYtdlpOption('embedMetadata', val)}
        />
        <Toggle
          label="SponsorBlock Integration"
          ariaLabel="Remove sponsor segments from videos using SponsorBlock"
          enabled={opts.sponsorBlock ?? false}
          onChange={(val) => updateYtdlpOption('sponsorBlock', val)}
        />

        <div>
          <label className="mb-1.5 block text-sm font-medium text-text-primary">
            Additional arguments
          </label>
          <input
            type="text"
            className="input w-full font-mono text-xs"
            placeholder="e.g. --limit-rate 5M --no-mtime"
            value={customArgs}
            onChange={(e) => setCustomArgs(e.target.value.replace(/[;&|$()]/g, ''))}
            // Saved when the field is left, not on every keystroke: each save
            // rewrites settings.json on the main process.
            onBlur={() => {
              if (customArgs !== (opts.customArgs ?? '')) updateYtdlpOption('customArgs', customArgs);
            }}
          />
          <p className="mt-1.5 text-[11px] text-text-secondary leading-snug">
            Passed directly to yt-dlp. Shell escaping characters [ ; & | $ ( ) ] are disabled.
          </p>
        </div>

        <div className="pt-2 border-t border-border-subtle">
          <label className="mb-2 block text-sm font-medium text-text-primary">
            Installed Plugins
          </label>
          {plugins.length === 0 ? (
            <p className="text-[11px] text-text-secondary italic">No plugins detected.</p>
          ) : (
            <div className="space-y-2">
              {plugins.map((plugin, i) => (
                <div key={i} className="flex items-center gap-2 rounded-md bg-surface-3 px-2.5 py-1.5 border border-border-subtle">
                  <Package className="h-3.5 w-3.5 text-text-secondary" />
                  <span className="text-xs font-medium text-text-primary">{plugin.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

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

export function YtDlpSettings({ settings, onSettingsChange }: YtDlpSettingsProps) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);

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

  const opts = settings.ytdlpOptions || {
    embedSubs: true,
    embedMetadata: true,
    sponsorBlock: false,
    customArgs: '',
  };

  return (
    <section className="card card-pad">
      <h3 className="text-sm font-medium text-text-primary">Advanced yt-dlp Options</h3>
      <p className="mt-0.5 mb-4 text-xs text-text-secondary">Configure low-level download engine behavior.</p>

      <div className="space-y-4 border-t border-border-subtle pt-3">
        <Toggle
          label="Embed Subtitles"
          ariaLabel="Embed subtitles in the output file if available"
          enabled={opts.embedSubs ?? true}
          onChange={(val) => updateYtdlpOption('embedSubs', val)}
        />
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
            value={opts.customArgs || ''}
            onChange={(e) => {
              // Sanitize on input
              const val = e.target.value.replace(/[;&|$()]/g, '');
              updateYtdlpOption('customArgs', val);
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

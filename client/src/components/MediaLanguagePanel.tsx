import { Headphones, Subtitles } from 'lucide-react';
import type { DownloadPackagingMode, MediaTrackProbe, SubtitleFormat } from '../lib/types';
import { describePackagingMode, languageFlag } from '../lib/languages';

interface MediaLanguagePanelProps {
  probe: MediaTrackProbe;
  selectedAudioId: string | null;
  selectedSubtitleIds: Set<string>;
  subtitleMode: 'none' | 'embed' | 'sidecar';
  subtitleConvert: 'original' | 'srt' | 'vtt';
  subsOnly: boolean;
  packagingMode: DownloadPackagingMode;
  onAudioSelect: (id: string | null) => void;
  onSubtitleToggle: (id: string) => void;
  onSubtitleModeChange: (mode: 'none' | 'embed' | 'sidecar') => void;
  onSubtitleConvertChange: (format: 'original' | 'srt' | 'vtt') => void;
  onSubsOnlyChange: (value: boolean) => void;
}

function formatBadge(format: SubtitleFormat): string {
  return format === 'unknown' ? 'SUB' : format.toUpperCase();
}

export function MediaLanguagePanel({
  probe,
  selectedAudioId,
  selectedSubtitleIds,
  subtitleMode,
  subtitleConvert,
  subsOnly,
  packagingMode,
  onAudioSelect,
  onSubtitleToggle,
  onSubtitleModeChange,
  onSubtitleConvertChange,
  onSubsOnlyChange,
}: MediaLanguagePanelProps) {
  const hasAudio = probe.audioTracks.length > 0;
  const hasSubs = probe.subtitleTracks.length > 0;

  if (!hasAudio && !hasSubs) return null;

  return (
    <div className="card card-pad space-y-3 animate-fade-in">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-text-primary">Languages & subtitles</h3>
        <span className="badge bg-accent-muted text-accent">{describePackagingMode(packagingMode)}</span>
      </div>

      {hasAudio && (
        <section>
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-text-secondary">
            <Headphones className="h-3.5 w-3.5" />
            Audio tracks
          </div>
          <div className="space-y-1">
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-3">
              <input
                type="radio"
                name="audio-track"
                checked={selectedAudioId === null}
                onChange={() => onAudioSelect(null)}
                className="accent-accent"
              />
              <span className="text-text-secondary">Default / auto</span>
            </label>
            {probe.audioTracks.map((track) => (
              <label
                key={track.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-3"
              >
                <input
                  type="radio"
                  name="audio-track"
                  checked={selectedAudioId === track.id}
                  onChange={() => onAudioSelect(track.id)}
                  className="accent-accent"
                />
                <span className="text-base leading-none" aria-hidden>{languageFlag(track.language)}</span>
                <span className="min-w-0 flex-1 truncate text-text-primary">{track.label}</span>
                <span className="flex shrink-0 gap-1">
                  {track.isDefault && <span className="badge bg-surface-3 text-text-secondary">Default</span>}
                  {track.isOriginal && <span className="badge bg-surface-3 text-text-secondary">Original</span>}
                  {track.isDub && <span className="badge bg-warning-muted text-warning">Dub</span>}
                </span>
              </label>
            ))}
          </div>
        </section>
      )}

      {hasSubs && (
        <section>
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-text-secondary">
            <Subtitles className="h-3.5 w-3.5" />
            Subtitle tracks
          </div>
          <div className="space-y-1">
            {probe.subtitleTracks.map((track) => (
              <label
                key={track.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-3"
              >
                <input
                  type="checkbox"
                  checked={selectedSubtitleIds.has(track.id)}
                  onChange={() => onSubtitleToggle(track.id)}
                  className="accent-accent"
                />
                <span className="text-base leading-none" aria-hidden>{languageFlag(track.language)}</span>
                <span className="min-w-0 flex-1 truncate text-text-primary">{track.label}</span>
                <span className="badge bg-surface-3 text-text-secondary">{formatBadge(track.format)}</span>
              </label>
            ))}
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <div>
              <label className="field-label" htmlFor="subtitle-delivery">Delivery</label>
              <select
                id="subtitle-delivery"
                value={subtitleMode}
                onChange={(e) => onSubtitleModeChange(e.target.value as 'none' | 'embed' | 'sidecar')}
                className="select-field"
                disabled={selectedSubtitleIds.size === 0}
              >
                <option value="sidecar">Separate files</option>
                <option value="embed">Embed in video</option>
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor="subtitle-convert">Convert to</label>
              <select
                id="subtitle-convert"
                value={subtitleConvert}
                onChange={(e) => onSubtitleConvertChange(e.target.value as 'original' | 'srt' | 'vtt')}
                className="select-field"
                disabled={selectedSubtitleIds.size === 0}
              >
                <option value="original">Original format</option>
                <option value="srt">SRT</option>
                <option value="vtt">VTT</option>
              </select>
            </div>
            <div className="flex items-end">
              <label className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-border-subtle px-2 py-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={subsOnly}
                  onChange={(e) => onSubsOnlyChange(e.target.checked)}
                  disabled={selectedSubtitleIds.size === 0}
                  className="accent-accent"
                />
                Subtitles only (no video)
              </label>
            </div>
          </div>
        </section>
      )}

      {probe.notes.length > 0 && (
        <p className="text-xs text-text-disabled">{probe.notes[probe.notes.length - 1]}</p>
      )}
    </div>
  );
}

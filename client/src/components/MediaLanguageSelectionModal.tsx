import { X } from 'lucide-react';
import type { MediaTrackProbe, DownloadPackagingMode, SubtitleFormat } from '../lib/types';
import { MediaLanguagePanel } from './MediaLanguagePanel';

interface MediaLanguageSelectionModalProps {
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
    onConfirm: () => void;
    onCancel: () => void;
}

export function MediaLanguageSelectionModal({
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
    onConfirm,
    onCancel,
}: MediaLanguageSelectionModalProps) {
    const hasAudio = probe.audioTracks.length > 0;
    const hasSubs = probe.subtitleTracks.length > 0;
    const hasAlternateTracks = hasAudio || hasSubs;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px] animate-fade-in">
            <div className="flex w-full max-w-md flex-col rounded-lg border border-border bg-surface-1 shadow-3 animate-modal-enter max-h-[90vh] overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
                    <h2 className="text-sm font-semibold text-text-primary">
                        {hasAlternateTracks ? 'Select Languages & Subtitles' : 'Probe Details'}
                    </h2>
                    <button type="button" onClick={onCancel} className="btn-icon" aria-label="Close">
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto px-4 py-3 custom-scrollbar">
                    <MediaLanguagePanel
                        probe={probe}
                        selectedAudioId={selectedAudioId}
                        selectedSubtitleIds={selectedSubtitleIds}
                        subtitleMode={subtitleMode}
                        subtitleConvert={subtitleConvert}
                        subsOnly={subsOnly}
                        packagingMode={packagingMode}
                        onAudioSelect={onAudioSelect}
                        onSubtitleToggle={onSubtitleToggle}
                        onSubtitleModeChange={onSubtitleModeChange}
                        onSubtitleConvertChange={onSubtitleConvertChange}
                        onSubsOnlyChange={onSubsOnlyChange}
                    />

                    {probe.audioTracks.length === 0 && probe.subtitleTracks.length === 0 && (
                        <div className="space-y-2 rounded-md border border-border-subtle bg-surface-2 p-3">
                            <p className="text-sm text-text-secondary">No alternate audio or subtitle tracks detected for this source.</p>
                            {probe.notes.length > 0 && (
                                <div className="space-y-1">
                                    <p className="text-xs font-medium text-text-disabled">Details:</p>
                                    {probe.notes.map((note) => (
                                        <p key={note} className="text-xs text-text-disabled">{note}</p>
                                    ))}
                                </div>
                            )}
                            <div className="mt-2 space-y-1 rounded bg-surface-3 p-2 text-xs text-text-disabled">
                                <p><strong>Probe source:</strong> {probe.source}</p>
                                <p><strong>Audio tracks found:</strong> {probe.audioTracks.length}</p>
                                <p><strong>Subtitle tracks found:</strong> {probe.subtitleTracks.length}</p>
                                {probe.manifestUrl && <p><strong>Manifest:</strong> {probe.manifestType?.toUpperCase() || 'unknown'}</p>}
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex gap-2 border-t border-border-subtle bg-surface-2 px-4 py-3">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="btn-secondary flex-1"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        className="btn-primary flex-1"
                    >
                        {hasAlternateTracks ? 'Confirm & Download' : 'Proceed with Default'}
                    </button>
                </div>
            </div>
        </div>
    );
}

import {
  ChevronDown,
  Clipboard,
  Layers3,
  Loader2,
  Play,
  Search,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlowToggle } from '../../components/FlowToggle';
import { MediaLanguageSelectionModal } from '../../components/MediaLanguageSelectionModal';
import type { CaptureMode, DownloadPackagingMode, MediaTrackProbe, PlaylistProbe, StreamOptionsProbeResult, UrlAnalysis } from '../../lib/types';
import { computePackagingMode } from '../../lib/languages';
import { inferModeFromText } from '../../lib/url-routing';
import { playDiscovery, playPop } from '../../lib/audio';

interface CaptureViewProps {
  mode: CaptureMode;
  setMode: (mode: CaptureMode) => void;
  outputDir: string;
  /**
   * A URL delivered from outside the view (clipboard watcher, Edit > Paste).
   *
   * This is a prop rather than the app writing into the input's DOM node,
   * because the input is a controlled React input: assigning `input.value` and
   * firing a synthetic `input` event also updates React's internal value
   * tracker, so React sees no change, never calls onChange, and re-renders the
   * field back to its state value — leaving an empty box and its placeholder.
   * That is why a captured URL only appeared until the next render and had to
   * be re-pasted by hand.
   */
  incomingUrl?: { url: string; seq: number } | null;
  onError: (message: string) => void;
  onStarted: (info: { title: string; itemCount?: number }) => void;
}

/** How many probed items are shown per page in the preview list. */
const PREVIEW_BATCH_SIZE = 50;

type SelectionMode = 'all' | 'first' | 'range' | 'schedule';
type AudioPreference = 'auto' | 'dub' | 'sub';
type SubtitleMode = 'none' | 'embed' | 'sidecar';
type QualityChoice = { label: string; value: string };

function buildPlaylistItems(selection: SelectionMode, firstCount: number, rangeStart: number, rangeEnd: number) {
  if (selection === 'first') return `1-${Math.max(1, firstCount)}`;
  if (selection === 'range') return `${Math.max(1, rangeStart)}-${Math.max(Math.max(1, rangeStart), rangeEnd)}`;
  return undefined;
}

function supportLabel(probe: PlaylistProbe) {
  if (probe.support === 'playlist') return `${probe.itemCount} items`;
  if (probe.support === 'episode-range') return 'Episode range';
  if (probe.support === 'manifest-probe') return 'Stream probe';
  if (probe.support === 'direct') return 'Single file';
  return 'Unknown format';
}

function selectionLabel(value: SelectionMode, probe: PlaylistProbe | null) {
  if (probe?.support === 'episode-range' && value === 'all') return 'Current';
  if (value === 'schedule') return 'Schedule';
  if (value === 'first') return 'First N';
  if (value === 'range') return 'Range';
  return 'All';
}

function buildQualityValue(mode: CaptureMode, height: number) {
  if (mode === 'video') {
    return `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`;
  }
  return `best[height<=${height}]/best`;
}

function fallbackQualityChoices(mode: CaptureMode): QualityChoice[] {
  const heights = [1080, 720, 480, 360];
  const choices = heights.map((height) => ({
    label: `${height}p`,
    value: buildQualityValue(mode, height),
  }));
  choices.push({ label: 'Audio only', value: 'bestaudio/best' });
  return choices;
}

function defaultAudioTrackId(probe: MediaTrackProbe): string | null {
  if (probe.audioTracks.length <= 1) return null;
  return (
    probe.audioTracks.find((track) => track.isOriginal)?.id ||
    probe.audioTracks.find((track) => track.isDefault)?.id ||
    probe.audioTracks[0]?.id ||
    null
  );
}

function selectedEpisodeUrls(
  probe: PlaylistProbe | null,
  selection: SelectionMode,
  firstCount: number,
  rangeStart: number,
  rangeEnd: number,
) {
  if (probe?.support !== 'episode-range') return [];
  const firstEpisode = Number(probe.preview[0]?.id || 1);
  const start = selection === 'range' ? Math.max(1, rangeStart) : firstEpisode;
  const end =
    selection === 'all' || selection === 'schedule'
      ? firstEpisode
      : selection === 'first'
        ? firstEpisode + Math.max(1, firstCount) - 1
        : Math.max(start, rangeEnd);
  const urls: string[] = [];

  for (let episode = start; episode <= end; episode += 1) {
    const known = probe.preview.find((item) => Number(item.id) === episode)?.url;
    if (known) {
      urls.push(known);
      continue;
    }
    const firstUrl = probe.preview[0]?.url;
    const firstId = probe.preview[0]?.id;
    if (!firstUrl || !firstId) continue;
    urls.push(firstUrl.replace(new RegExp(`(ep-|[?&]e=)${firstId}(?=&|$)`), `$1${episode}`));
  }

  return urls;
}

export function CaptureView({ mode, setMode, outputDir, incomingUrl, onError, onStarted }: CaptureViewProps) {
  const [url, setUrl] = useState('');
  const [analysis, setAnalysis] = useState<UrlAnalysis | null>(null);
  const [probe, setProbe] = useState<PlaylistProbe | null>(null);
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(false);
  const [quality, setQuality] = useState('');
  const [selection, setSelection] = useState<SelectionMode>('all');
  const [firstCount, setFirstCount] = useState(24);
  const [rangeStart, setRangeStart] = useState(1);
  const [rangeEnd, setRangeEnd] = useState(24);
  const [scheduledAt, setScheduledAt] = useState('');
  const [audioPreference, setAudioPreference] = useState<AudioPreference>('auto');
  const [subtitleMode, setSubtitleMode] = useState<SubtitleMode>('embed');
  const [impersonate, setImpersonate] = useState('');
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [dragOverWindow, setDragOverWindow] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [trackProbe, setTrackProbe] = useState<MediaTrackProbe | null>(null);
  const [probingTracks, setProbingTracks] = useState(false);
  const [selectedAudioId, setSelectedAudioId] = useState<string | null>(null);
  const [selectedSubtitleIds, setSelectedSubtitleIds] = useState<Set<string>>(new Set());
  const [subtitleConvert, setSubtitleConvert] = useState<'original' | 'srt' | 'vtt'>('original');
  const [subsOnly, setSubsOnly] = useState(false);
  const [showLanguageModal, setShowLanguageModal] = useState(false);
  const [streamOptions, setStreamOptions] = useState<StreamOptionsProbeResult | null>(null);
  const [selectedStreamOption, setSelectedStreamOption] = useState<string | null>(null);
  const [probingStreamOptions, setProbingStreamOptions] = useState(false);

  const toggleIndex = useCallback((index: number) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const fillRange = useCallback((from: number, to: number) => {
    const set = new Set<number>();
    for (let i = from; i <= to; i++) set.add(i);
    setSelectedIndices(set);
  }, []);

  const clearSelection = useCallback(() => setSelectedIndices(new Set()), []);
  const hasSelection = selectedIndices.size > 0;

  // Long series are paged into groups of 50 so a 366-episode list is navigable.
  // This is presentation only: `probe.preview` and `probe.itemCount` are the
  // real, already-detected episodes, and paging neither adds to them nor
  // truncates them — it just decides which slice is on screen.
  const [batchIndex, setBatchIndex] = useState(0);
  const batchCount = probe ? Math.max(1, Math.ceil(probe.preview.length / PREVIEW_BATCH_SIZE)) : 1;
  const batchStart = batchIndex * PREVIEW_BATCH_SIZE;
  const visiblePreview = probe
    ? probe.preview.slice(batchStart, batchStart + PREVIEW_BATCH_SIZE)
    : [];

  // A new probe replaces the list; stay on a page that no longer exists and the
  // preview renders empty.
  useEffect(() => { setBatchIndex(0); }, [probe]);

  useEffect(() => {
    if (!probe) return;
    const total = probe.preview.length;
    if (total === 0) return;
    if (selection === 'all' || selection === 'first' || selection === 'schedule') {
      const count = selection === 'all' || selection === 'schedule' ? total : Math.min(firstCount, total);
      setSelectedIndices(new Set(Array.from({ length: count }, (_, i) => i)));
    } else if (selection === 'range') {
      const start = Math.max(0, rangeStart - 1);
      const end = Math.min(rangeEnd - 1, total - 1);
      if (start <= end) fillRange(start, end);
    }
  }, [selection, firstCount, rangeStart, rangeEnd, probe, fillRange]);

  const canUsePlaylistControls = mode === 'video' && (probe?.support === 'playlist' || selection !== 'all');
  const plannedItems = useMemo(
    () => buildPlaylistItems(selection, firstCount, rangeStart, rangeEnd),
    [firstCount, rangeEnd, rangeStart, selection],
  );
  const episodeUrls = useMemo(
    () => selectedEpisodeUrls(probe, selection, firstCount, rangeStart, rangeEnd),
    [firstCount, probe, rangeEnd, rangeStart, selection],
  );

  // useCallback (with all-stable deps: setState setters plus the already-memoized
  // clearSelection) so handleInputUrl below can depend on this without picking up a
  // new identity — and therefore without re-running — on every render.
  const resetPlan = useCallback(() => {
    setAnalysis(null);
    setProbe(null);
    setTrackProbe(null);
    setSelectedAudioId(null);
    setSelectedSubtitleIds(new Set());
    setSubsOnly(false);
    setStreamOptions(null);
    setSelectedStreamOption(null);
    clearSelection();
    setQuality('');
  }, [clearSelection]);

  const handleInputUrl = useCallback((newUrl: string) => {
    setUrl(newUrl);
    setMode(inferModeFromText(newUrl));
    resetPlan();
  }, [resetPlan, setMode]);

  // A URL captured outside this view goes through the same path as typing or
  // dropping one, so the field, the mode inference and any stale plan all end
  // up consistent. Keyed on `seq` so re-copying the same URL delivers again.
  useEffect(() => {
    if (!incomingUrl?.url) return;
    handleInputUrl(incomingUrl.url);
    // handleInputUrl is stable (useCallback over stable deps); seq is the signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingUrl?.seq]);

  // Window-wide drag-and-drop: dropping a URL anywhere in the capture view fills the input.
  useEffect(() => {
    let dragCounter = 0;
    const onDragEnter = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('text/uri-list') || e.dataTransfer?.types.includes('text/plain')) {
        e.preventDefault();
        dragCounter++;
        setDragOverWindow(true);
      }
    };
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter === 0) setDragOverWindow(false);
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      dragCounter = 0;
      setDragOverWindow(false);
      const text = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain');
      if (text) {
        const firstUrl = text.split(/[\s\r\n]+/).find((t) => t.startsWith('http'));
        if (firstUrl) handleInputUrl(firstUrl);
      }
    };

    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onDrop);
    };
  }, [handleInputUrl]);

  const loadMediaTracks = useCallback(async (pageUrl: string) => {
    if (!window.streamDock?.probeMediaTracks) return;
    setProbingTracks(true);
    try {
      const result = await window.streamDock.probeMediaTracks({ pageUrl });
      if (!result?.success) {
        console.warn('[StreamDock] probeMediaTracks failed:', result?.error);
        return;
      }
      console.log('[StreamDock] probeMediaTracks result:', result.data);
      setTrackProbe(result.data);
      const defaultSubs = result.data.subtitleTracks.filter((t) => t.isDefault).map((t) => t.id);
      if (defaultSubs.length > 0) setSelectedSubtitleIds(new Set(defaultSubs));
      setSelectedAudioId(defaultAudioTrackId(result.data));
    } catch (error) {
      console.error('[StreamDock] probeMediaTracks error:', error);
    } finally {
      setProbingTracks(false);
    }
  }, []);

  const loadStreamOptions = useCallback(async (pageUrl: string) => {
    if (!window.streamDock?.probeStreamOptions) return;
    setProbingStreamOptions(true);
    try {
      const result = await window.streamDock.probeStreamOptions(pageUrl);
      console.log('[StreamDock] probeStreamOptions result:', result);
      if (result.success && result.options.length > 1) {
        setStreamOptions(result);
        const defaultManifestUrl = result.defaultOption?.manifestUrl || result.options[0].manifestUrl;
        setSelectedStreamOption(defaultManifestUrl);
        // Probe tracks for the default stream option's manifest
        if (window.streamDock?.probeMediaTracks && defaultManifestUrl !== pageUrl) {
          setProbingTracks(true);
          try {
            const trackResult = await window.streamDock.probeMediaTracks({ pageUrl: defaultManifestUrl, manifestUrl: defaultManifestUrl });
            if (trackResult?.success) {
              setTrackProbe(trackResult.data);
              const defaultSubs = trackResult.data.subtitleTracks.filter((t) => t.isDefault).map((t) => t.id);
              if (defaultSubs.length > 0) setSelectedSubtitleIds(new Set(defaultSubs));
              setSelectedAudioId(defaultAudioTrackId(trackResult.data));
            }
          } catch (error) {
            console.error('[StreamDock] probeMediaTracks for default stream option error:', error);
          } finally {
            setProbingTracks(false);
          }
        }
      } else {
        setStreamOptions(null);
        setSelectedStreamOption(null);
      }
    } catch (error) {
      console.error('[StreamDock] probeStreamOptions error:', error);
      setStreamOptions(null);
      setSelectedStreamOption(null);
    } finally {
      setProbingStreamOptions(false);
    }
  }, []);

  const selectedAudioLanguage = useMemo(() => {
    if (!trackProbe || !selectedAudioId) return undefined;
    return trackProbe.audioTracks.find((t) => t.id === selectedAudioId)?.language;
  }, [trackProbe, selectedAudioId]);

  const selectedAudioTrack = useMemo(() => {
    if (!trackProbe || !selectedAudioId) return undefined;
    return trackProbe.audioTracks.find((t) => t.id === selectedAudioId);
  }, [trackProbe, selectedAudioId]);

  const selectedSubtitleLanguages = useMemo(() => {
    if (!trackProbe || selectedSubtitleIds.size === 0) return [];
    const langs = new Set<string>();
    for (const id of selectedSubtitleIds) {
      const track = trackProbe.subtitleTracks.find((t) => t.id === id);
      if (track) langs.add(track.language);
    }
    return Array.from(langs);
  }, [trackProbe, selectedSubtitleIds]);

  const selectedSubtitleTracks = useMemo(() => {
    if (!trackProbe || selectedSubtitleIds.size === 0) return [];
    return trackProbe.subtitleTracks.filter((t) => selectedSubtitleIds.has(t.id));
  }, [trackProbe, selectedSubtitleIds]);

  const packagingMode: DownloadPackagingMode = useMemo(
    () => computePackagingMode({
      subsOnly,
      audioLanguage: selectedAudioLanguage,
      subtitleLanguages: selectedSubtitleLanguages,
    }),
    [subsOnly, selectedAudioLanguage, selectedSubtitleLanguages],
  );

  const resolvedYtDlpSummary = useMemo(() => {
    const format = selectedAudioTrack?.formatId
      ? `${quality || 'bestvideo'}+${selectedAudioTrack.formatId}`
      : quality || 'bestvideo+bestaudio/best';
    const subLangs = selectedSubtitleLanguages.length ? selectedSubtitleLanguages.join(',') : undefined;
    const subtitleArgs = subLangs && subtitleMode !== 'none'
      ? `--write-subs --sub-langs ${subLangs}${subtitleMode === 'embed' ? ' --embed-subs' : ''}`
      : 'no subtitles';
    return {
      format,
      subtitleArgs,
    };
  }, [quality, selectedAudioTrack?.formatId, selectedSubtitleLanguages, subtitleMode]);

  const qualityChoices = useMemo(() => {
    const detectedHeights = Array.from(
      new Set([
        ...(probe?.qualityOptions || []).map((option) => option.height),
        ...(trackProbe?.qualityOptions || []).map((option) => option.height),
      ].filter((height) => height > 0)),
    ).sort((a, b) => b - a);

    if (detectedHeights.length === 0) return fallbackQualityChoices(mode);

    const detectedChoices = detectedHeights.map((height) => ({
      label: `${height}p`,
      value: buildQualityValue(mode, height),
    }));
    detectedChoices.push({ label: 'Audio only', value: 'bestaudio/best' });
    return detectedChoices;
  }, [mode, probe?.qualityOptions, trackProbe?.qualityOptions]);

  useEffect(() => {
    if (!quality) return;
    if (qualityChoices.some((option) => option.value === quality)) return;
    setQuality('');
  }, [quality, qualityChoices]);

  const toggleSubtitleTrack = useCallback((id: string) => {
    setSelectedSubtitleIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!probe || probe.preview.length === 0) return;
    playDiscovery();
    const count = Math.min(probe.preview.length, 12);
    for (let i = 0; i < count; i++) {
      setTimeout(() => playPop(0), i * 45);
    }
  }, [probe]);

  const paste = async () => {
    try {
      const text = await window.streamDock?.readClipboard();
      if (text) {
        const firstUrl = text.split(/[\s\r\n]+/).find((t) => t.startsWith('http'));
        if (!firstUrl) { onError('No URL found in clipboard.'); return; }
        handleInputUrl(firstUrl);
      }
    } catch {
      onError('Clipboard text could not be read.');
    }
  };

  const analyze = async () => {
    if (!url.trim()) {
      onError('Paste or type a URL first.');
      return null;
    }
    setBusy(true);
    try {
      const result = await window.streamDock?.analyzeUrl(url.trim());
      if (!result) throw new Error('Electron API is not available.');
      if (!result.success) {
        onError(result.error);
        setAnalysis(null);
        return null;
      }
      setAnalysis(result.data);
      return result.data;
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const inspect = async () => {
    const current = analysis?.url === url.trim() ? analysis : await analyze();
    if (!current) return null;
    setProbing(true);
    try {
      const result = await window.streamDock?.inspectUrl(current.url);
      if (!result) throw new Error('Electron API is not available.');
      if (!result.success) {
        onError(result.error);
        setProbe(null);
        return null;
      }
      setProbe(result.data);
      if (result.data.support === 'playlist') {
        setSelection('all');
        setRangeEnd(Math.max(1, Math.min(result.data.itemCount, 24)));
        setFirstCount(Math.max(1, Math.min(result.data.itemCount, 24)));
      } else if (result.data.support === 'episode-range') {
        const currentEpisode = Number(result.data.preview[0]?.id || 1);
        setSelection('first');
        setFirstCount(12);
        setRangeStart(currentEpisode);
        setRangeEnd(currentEpisode + 11);
      } else if (result.data.host === 'music.youtube.com') {
        setQuality('bestaudio/best');
        setSubtitleMode('none');
      }
      void loadMediaTracks(current.url);
      // For stream mode or anime sites, probe for separate language manifest URLs
      if (mode === 'stream' || ['anikoto', 'animepahe', 'hianime', 'gojoora'].some(h => current.host.includes(h))) {
        void loadStreamOptions(current.url);
      }
      return result.data;
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setProbing(false);
    }
  };

  const start = async () => {
    const current = analysis?.url === url.trim() ? analysis : await analyze();
    if (!current) return;
    if (!outputDir) {
      onError('Choose a save folder in Settings before starting.');
      return;
    }
    if (selection === 'schedule' && !scheduledAt) {
      onError('Please select a scheduled time.');
      return;
    }

    // Make sure we actually have probe metadata before queueing.
    //
    // start() only ever ran analyze() (which resolves the URL) and then read
    // `probe` out of the render closure. Pressing Download without pressing
    // Analyze first therefore queued with `probe === null` — no title, no
    // thumbnail, no playlist detection — which is why single videos showed up
    // as "Video download" behind a placeholder icon.
    const activeProbe = probe && analysis?.url === url.trim() ? probe : await inspect();

    const isPlaylist = activeProbe?.support === 'playlist';
    const isEpisodeRange = activeProbe?.support === 'episode-range';
    let batchUrls: string[];
    let playlistItems: string | undefined;

    if (selection === 'all' && activeProbe?.support === 'playlist' && selectedIndices.size === activeProbe.preview.length) {
      batchUrls = [current.url];
      playlistItems = undefined;
    } else if (hasSelection && selection !== 'schedule') {
      const sorted = Array.from(selectedIndices).sort((a, b) => a - b);
      if (isEpisodeRange && activeProbe) {
        const urls: string[] = [];
        for (const i of sorted) {
          const item = activeProbe.preview[i];
          if (item?.url) urls.push(item.url);
        }
        batchUrls = urls;
        playlistItems = undefined;
      } else {
        batchUrls = [current.url];
        // Only a real playlist can be addressed by --playlist-items. A single
        // video's probe still returns a one-item preview, and the auto-select
        // effect ticks it, so this branch used to emit playlistItems: '1' for
        // an ordinary video — which buildOutputTemplate reads as a confirmed
        // multi-item batch and wraps in a folder named from %(playlist_title)s,
        // i.e. the literal "NA" folder single downloads kept landing in.
        playlistItems = isPlaylist ? sorted.map((i) => i + 1).join(',') : undefined;
      }
    } else if (isEpisodeRange) {
      batchUrls = episodeUrls;
      playlistItems = undefined;
    } else {
      batchUrls = [current.url];
      playlistItems = canUsePlaylistControls && isPlaylist ? plannedItems : undefined;
    }

    const totalItems = hasSelection
      ? selectedIndices.size
      : isEpisodeRange
        ? episodeUrls.length
        : playlistItems
          ? (activeProbe?.itemCount ?? 0)
          : 1;

    setBusy(true);
    try {
      for (const batchUrl of batchUrls) {
        // One spawn handles many media items when yt-dlp is walking a playlist
        // itself; naming those from a single hint would give every file the
        // same name. Only a spawn that covers exactly one item gets a title.
        const spawnCoversOneItem = !playlistItems && !(isPlaylist && !playlistItems);
        const previewItem = activeProbe?.preview.find((item) => item.url === batchUrl)
          ?? (spawnCoversOneItem && activeProbe?.preview.length === 1 ? activeProbe.preview[0] : undefined);

        // The real title and thumbnail the probe already resolved. Previously
        // only episode-range downloads passed a title and nothing ever passed a
        // thumbnail, so ordinary videos queued as "Video download" behind a
        // placeholder icon.
        //
        // The naming hint is withheld for a multi-item spawn, but the *display*
        // title is not: a playlist should still show its own name in the queue
        // while yt-dlp names each file inside it from that file's own metadata.
        const titleHint = spawnCoversOneItem
          ? (previewItem?.title ?? activeProbe?.title)
          : undefined;
        const displayTitle = previewItem?.title ?? activeProbe?.title;
        const thumbnail = previewItem?.thumbnail ?? activeProbe?.thumbnail;
        let parsedScheduledAt: string | undefined;
        if (selection === 'schedule' && scheduledAt) {
          const [hours, minutes] = scheduledAt.split(':').map(Number);
          const d = new Date();
          d.setHours(hours, minutes, 0, 0);
          if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
          parsedScheduledAt = d.toISOString();
        }

        // Get the selected stream option if available
        const selectedOption = selectedStreamOption ? streamOptions?.options.find(o => o.manifestUrl === selectedStreamOption) : undefined;

        // A folder is created only once more than one item is actually being
        // queued. This used to be set for every episode-range download, so
        // grabbing a single episode still buried it inside a show folder —
        // the "folder appears even for a single video" report.
        const folderHint = batchUrls.length > 1 ? activeProbe?.title : undefined;

        await window.streamDock?.startDownload(mode, {
          url: batchUrl,
          outputDir,
          quality: quality || undefined,
          playlistItems: batchUrls.length > 1 ? undefined : playlistItems,
          audioPreference,
          subtitleMode,
          isPlaylist: isPlaylist && !playlistItems,
          folderHint,
          titleHint,
          displayTitle,
          thumbnail,
          impersonate: impersonate || undefined,
          scheduledAt: parsedScheduledAt,
          selectedAudioLanguage,
          selectedAudioFormatId: selectedAudioTrack?.formatId,
          selectedAudioManifestUrl: selectedAudioTrack?.manifestUrl,
          selectedSubtitleLanguages: selectedSubtitleLanguages.length ? selectedSubtitleLanguages : undefined,
          selectedSubtitleFormatIds: selectedSubtitleTracks.map((track) => track.formatId).filter(Boolean) as string[],
          selectedSubtitleManifestUrls: Array.from(new Set(selectedSubtitleTracks.map((track) => track.manifestUrl).filter(Boolean) as string[])),
          subtitleConvertFormat: subtitleConvert,
          subsOnly,
          downloadPackaging: packagingMode,
          manifestUrl: selectedOption?.manifestUrl,
          manifestReferer: selectedOption?.referer,
        });
      }
      setUrl('');
      resetPlan();
      onStarted({ title: activeProbe?.title || current.url, itemCount: totalItems > 1 ? totalItems : undefined });
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');

  return (
    <section className="relative flex flex-col gap-4">
      {dragOverWindow && (
        <div className="pointer-events-none fixed inset-2 z-[100] flex flex-col items-center justify-center rounded-lg border border-dashed border-accent/40 bg-accent/5">
          <Upload className="mb-2 h-8 w-8 text-accent" />
          <p className="text-sm font-medium text-accent">Drop URL to capture</p>
        </div>
      )}

      {showLanguageModal && (trackProbe || streamOptions) && (
        <MediaLanguageSelectionModal
          probe={trackProbe || undefined}
          streamOptions={streamOptions || undefined}
          selectedAudioId={selectedAudioId}
          selectedSubtitleIds={selectedSubtitleIds}
          subtitleMode={subtitleMode}
          subtitleConvert={subtitleConvert}
          subsOnly={subsOnly}
          packagingMode={packagingMode}
          resolvedFormat={resolvedYtDlpSummary.format}
          resolvedSubtitleArgs={resolvedYtDlpSummary.subtitleArgs}
          selectedStreamOption={selectedStreamOption || undefined}
          onAudioSelect={setSelectedAudioId}
          onSubtitleToggle={toggleSubtitleTrack}
          onSubtitleClear={() => {
            setSelectedSubtitleIds(new Set());
            setSubtitleMode('none');
            setSubsOnly(false);
          }}
          onSubtitleModeChange={setSubtitleMode}
          onSubtitleConvertChange={setSubtitleConvert}
          onSubsOnlyChange={setSubsOnly}
          onStreamOptionSelect={async (manifestUrl: string) => {
              setSelectedStreamOption(manifestUrl);
              // Re-probe tracks for the selected manifest URL since different languages
              // may be on different manifest URLs (separate streams)
              if (window.streamDock?.probeMediaTracks) {
                setProbingTracks(true);
                try {
                  const result = await window.streamDock.probeMediaTracks({ pageUrl: manifestUrl, manifestUrl });
                  if (result?.success) {
                    setTrackProbe(result.data);
                    const defaultSubs = result.data.subtitleTracks.filter((t) => t.isDefault).map((t) => t.id);
                    if (defaultSubs.length > 0) setSelectedSubtitleIds(new Set(defaultSubs));
                    setSelectedAudioId(defaultAudioTrackId(result.data));
                  }
                } catch (error) {
                  console.error('[StreamDock] probeMediaTracks for stream option error:', error);
                } finally {
                  setProbingTracks(false);
                }
              }
            }}
          onConfirm={() => {
            setShowLanguageModal(false);
            void start();
          }}
          onCancel={() => setShowLanguageModal(false)}
        />
      )}

      <div className="flex items-center justify-end">
        <FlowToggle value={mode} onChange={setMode} />
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); void inspect(); }}
        className="flex flex-col gap-2"
      >
        <div className="relative">
          <input
            name="capture-url"
            type="url"
            inputMode="url"
            autoComplete="off"
            value={url}
            onChange={(e) => handleInputUrl(e.target.value)}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            data-selectable
            aria-label="Media URL"
            placeholder="Paste a video, playlist, or stream URL…"
            className="input-field h-9 pr-20"
          />
          {url === '' && !inputFocused && (
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-[10px] text-text-disabled">
              {isMac ? '⌘V' : 'Ctrl+V'}
            </span>
          )}
          {url && (
            <button
              type="button"
              onClick={() => { setUrl(''); resetPlan(); }}
              aria-label="Clear URL"
              className="btn-icon absolute right-1.5 top-1/2 -translate-y-1/2"
            >
              <XCircle className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={paste} className="btn-ghost" title="Paste from clipboard">
            <Clipboard className="h-3.5 w-3.5" />
            Paste
          </button>
          <button type="submit" disabled={busy || probing} className="btn-secondary">
            {probing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            Analyze
          </button>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <select
              name="download-quality"
              aria-label="Quality"
              value={quality}
              onChange={(e) => setQuality(e.target.value)}
              disabled={busy}
              className="select-field h-8 w-36"
            >
              <option value="">Best quality</option>
              {qualityChoices.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button type="button" onClick={start} disabled={busy || probing} className="btn-primary min-w-[88px]">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5 fill-current" />}
              Download
            </button>
          </div>
        </div>
      </form>

      {analysis && !probe && !busy && !probing && (
        <div className="flex items-center gap-2 rounded-md border border-border-subtle bg-surface-2 px-3 py-2 text-sm animate-fade-in">
          <span className="font-medium text-accent" translate="no">{analysis.host}</span>
          <span className="text-text-disabled">·</span>
          <span className="text-text-secondary">{analysis.suggestedMode} — {analysis.reason}</span>
        </div>
      )}

      {(probingTracks || trackProbe || probingStreamOptions || streamOptions) && (
        probingTracks ? (
          <div className="card card-pad flex items-center gap-2 text-sm text-text-secondary">
            <Loader2 className="h-4 w-4 animate-spin text-accent" />
            Detecting available audio and subtitle tracks…
          </div>
        ) : probingStreamOptions ? (
          <div className="card card-pad flex items-center gap-2 text-sm text-text-secondary">
            <Loader2 className="h-4 w-4 animate-spin text-accent" />
            Detecting language stream options…
          </div>
        ) : streamOptions && streamOptions.options.length > 1 ? (
          <div className="card card-pad flex items-center justify-between gap-2 animate-fade-in">
            <div className="flex items-center gap-2 text-sm text-text-secondary">
              <span>{streamOptions.options.length} language streams detected</span>
            </div>
            <button
              type="button"
              onClick={() => setShowLanguageModal(true)}
              className="btn-secondary text-sm"
            >
              Select Stream
            </button>
          </div>
        ) : trackProbe ? (
          trackProbe.audioTracks.length > 0 || trackProbe.subtitleTracks.length > 0 ? (
            <div className="card card-pad flex items-center justify-between gap-2 animate-fade-in">
              <div className="flex items-center gap-2 text-sm text-text-secondary">
                <span>Available tracks detected</span>
              </div>
              <button
                type="button"
                onClick={() => setShowLanguageModal(true)}
                className="btn-secondary text-sm"
              >
                Select Languages
              </button>
            </div>
          ) : (
            <div className="card card-pad flex items-center justify-between gap-2 animate-fade-in">
              <div className="flex flex-col gap-1 text-sm">
                <p className="text-text-secondary">No alternate audio or subtitle tracks detected</p>
                <p className="text-xs text-text-disabled">Proceeding with default settings</p>
              </div>
              <button
                type="button"
                onClick={() => setShowLanguageModal(true)}
                className="btn-secondary text-sm"
              >
                View Details
              </button>
            </div>
          )
        ) : null
      )}

      {(probe || analysis || busy) && (
        <div className="grid gap-3 lg:grid-cols-2 animate-entrance-row">
          {/* Preview */}
          <div className="card card-pad flex min-w-0 flex-col">
            <div className="mb-2 flex items-center gap-2 border-b border-border-subtle pb-2">
              <Layers3 className="h-3.5 w-3.5 text-text-secondary" />
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-medium text-text-primary">
                  {probe?.title || 'Media preview'}
                </h3>
                <p className="truncate text-xs text-text-secondary">
                  {probe ? `${probe.host} · ${supportLabel(probe)}` : busy ? 'Analyzing…' : 'Run analyze to inspect'}
                </p>
              </div>
              {probe?.thumbnail && (
                <img src={probe.thumbnail} alt="" className="h-8 w-12 shrink-0 rounded object-cover" />
              )}
            </div>

            {(busy || probing) && !probe && (
              <div className="space-y-1.5">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-9 rounded-md bg-surface-3 animate-shimmer bg-gradient-to-r from-surface-3 via-surface-4 to-surface-3 bg-[length:200%_100%]" />
                ))}
              </div>
            )}

            {probe && (
              <div className="max-h-72 space-y-1 overflow-y-auto custom-scrollbar pr-1">
                {visiblePreview.map((item, offset) => {
                  const index = batchStart + offset;
                  return (
                  <label
                    key={`${item.id || item.title}-${index}`}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-surface-3"
                  >
                    <input
                      type="checkbox"
                      checked={selectedIndices.has(index)}
                      onChange={() => toggleIndex(index)}
                      className="h-3.5 w-3.5 shrink-0 rounded border-border accent-accent"
                    />
                    {item.thumbnail ? (
                      <img src={item.thumbnail} alt="" className="h-7 w-10 shrink-0 rounded object-cover" />
                    ) : (
                      <span className="w-5 shrink-0 text-center text-xs text-text-disabled">{index + 1}</span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-text-primary">{item.title}</span>
                    {item.duration != null && (
                      <span className="shrink-0 text-xs tabular-nums text-text-secondary">
                        {Math.floor(item.duration / 60)}:{(item.duration % 60).toString().padStart(2, '0')}
                      </span>
                    )}
                  </label>
                  );
                })}
              </div>
            )}

            {probe && batchCount > 1 && (
              <div className="mt-2 flex items-center justify-between gap-2 border-t border-border-subtle pt-2 text-xs">
                <button
                  type="button"
                  onClick={() => setBatchIndex((i) => Math.max(0, i - 1))}
                  disabled={batchIndex === 0}
                  className="rounded-md bg-surface-3 px-2 py-1 text-text-secondary transition-colors hover:text-text-primary disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="tabular-nums text-text-secondary">
                  {batchStart + 1}–{Math.min(batchStart + PREVIEW_BATCH_SIZE, probe.preview.length)} of {probe.preview.length}
                </span>
                <button
                  type="button"
                  onClick={() => setBatchIndex((i) => Math.min(batchCount - 1, i + 1))}
                  disabled={batchIndex >= batchCount - 1}
                  className="rounded-md bg-surface-3 px-2 py-1 text-text-secondary transition-colors hover:text-text-primary disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            )}

            {!probe && !busy && !probing && (
              <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-border-subtle py-8 text-center">
                <Search className="mb-2 h-5 w-5 text-text-disabled" />
                <p className="text-sm text-text-secondary">Analyze a URL to see playlist or episode details</p>
              </div>
            )}

            {probe?.notes.map((note) => (
              <p key={note} className="mt-2 rounded-md bg-surface-3 px-2 py-1.5 text-xs text-text-secondary">{note}</p>
            ))}
          </div>

          {/* Options */}
          <div className="card card-pad flex min-w-0 flex-col">
            <h3 className="mb-2 text-sm font-medium text-text-primary">Download options</h3>

            <div className="grid grid-cols-4 gap-1.5">
              {(['all', 'first', 'range', 'schedule'] as SelectionMode[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setSelection(value)}
                  disabled={mode === 'stream' && probe?.support !== 'episode-range'}
                  className={`h-7 rounded-md text-xs font-medium transition-colors disabled:opacity-40 ${selection === value
                    ? 'bg-accent text-white'
                    : 'bg-surface-3 text-text-secondary hover:text-text-primary'
                    }`}
                >
                  {selectionLabel(value, probe)}
                </button>
              ))}
            </div>

            {hasSelection && selection !== 'schedule' && (
              <div className="mt-2 flex items-center justify-between rounded-md bg-surface-3 px-2 py-1.5 text-xs">
                <span className="text-text-primary">{selectedIndices.size} selected</span>
                <button type="button" onClick={clearSelection} className="text-text-secondary hover:text-text-primary">
                  <X className="inline h-3 w-3" /> Clear
                </button>
              </div>
            )}

            <div className="mt-3 space-y-2">
              {selection === 'first' && (
                <div>
                  <label htmlFor="batch-size" className="field-label">Count</label>
                  <input
                    id="batch-size"
                    type="number"
                    min={1}
                    value={firstCount}
                    data-selectable
                    onChange={(e) => setFirstCount(Number(e.target.value))}
                    className="input-field"
                  />
                </div>
              )}
              {selection === 'range' && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label htmlFor="range-start" className="field-label">From</label>
                    <input id="range-start" type="number" min={1} value={rangeStart} data-selectable onChange={(e) => setRangeStart(Number(e.target.value))} className="input-field" />
                  </div>
                  <div>
                    <label htmlFor="range-end" className="field-label">To</label>
                    <input id="range-end" type="number" min={1} value={rangeEnd} data-selectable onChange={(e) => setRangeEnd(Number(e.target.value))} className="input-field" />
                  </div>
                </div>
              )}
              {selection === 'schedule' && (
                <div>
                  <label htmlFor="schedule-time" className="field-label">Start time</label>
                  <input id="schedule-time" type="time" value={scheduledAt} data-selectable onChange={(e) => setScheduledAt(e.target.value)} className="input-field" />
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => setAdvancedOpen(!advancedOpen)}
              className="mt-3 flex w-full items-center gap-1 text-xs text-text-secondary hover:text-text-primary"
            >
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
              Advanced options
            </button>

            {advancedOpen && (
              <div className="mt-2 grid grid-cols-2 gap-2 border-t border-border-subtle pt-2">
                <div>
                  <label htmlFor="audio-mode" className="field-label">Audio</label>
                  <select id="audio-mode" value={audioPreference} onChange={(e) => setAudioPreference(e.target.value as AudioPreference)} className="select-field">
                    <option value="auto">Auto</option>
                    <option value="dub">English dub</option>
                    <option value="sub">Original</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="subtitle-mode" className="field-label">Subtitles</label>
                  <select id="subtitle-mode" value={subtitleMode} onChange={(e) => setSubtitleMode(e.target.value as SubtitleMode)} className="select-field">
                    <option value="embed">Embed</option>
                    <option value="sidecar">Sidecar .srt</option>
                    <option value="none">None</option>
                  </select>
                </div>
                <div className="col-span-2">
                  <label htmlFor="spoof-agent" className="field-label">Browser impersonation</label>
                  <select id="spoof-agent" value={impersonate} onChange={(e) => setImpersonate(e.target.value)} className="select-field">
                    <option value="">Default</option>
                    <option value="chrome">Chrome</option>
                    <option value="firefox">Firefox</option>
                    <option value="safari">Safari</option>
                  </select>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

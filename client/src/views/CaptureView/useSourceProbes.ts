import { useCallback, useRef, useState } from 'react';
import type { MediaTrackProbe, StreamOptionsProbeResult } from '../../lib/types';

function defaultAudioTrackId(probe: MediaTrackProbe): string | null {
  if (probe.audioTracks.length <= 1) return null;
  return (
    probe.audioTracks.find((track) => track.isOriginal)?.id ||
    probe.audioTracks.find((track) => track.isDefault)?.id ||
    probe.audioTracks[0]?.id ||
    null
  );
}

/**
 * What the source offers beyond its playlist: separate language streams
 * (dub/sub) and the audio and subtitle tracks inside a manifest.
 *
 * Both are discovered in the background after Analyze. Every result is tagged
 * with the plan token it started under and dropped if the plan has moved on —
 * without that, analysing episode A, pasting episode B and letting A's
 * language probe land queued B with A's manifest: the wrong episode under B's
 * name. The token lives here, beside the probes it guards, rather than in a
 * view that had grown to 1164 lines.
 */
export function useSourceProbes() {
  const planToken = useRef(0);
  const [trackProbe, setTrackProbe] = useState<MediaTrackProbe | null>(null);
  const [probingTracks, setProbingTracks] = useState(false);
  const [selectedAudioId, setSelectedAudioId] = useState<string | null>(null);
  const [selectedSubtitleIds, setSelectedSubtitleIds] = useState<Set<string>>(new Set());
  const [streamOptions, setStreamOptions] = useState<StreamOptionsProbeResult | null>(null);
  const [selectedStreamOption, setSelectedStreamOption] = useState<string | null>(null);
  const [probingStreamOptions, setProbingStreamOptions] = useState(false);
  /**
   * Whether language discovery is in flight, readable synchronously. A handler
   * that has just started discovery (Download without Analyze does) would see
   * the `probingStreamOptions` value of the render it was created in — false —
   * and race straight past it.
   */
  const discovering = useRef(false);
  const isDiscovering = useCallback(() => discovering.current, []);

  /** Start a new plan: everything still in flight for the old one is ignored. */
  const reset = useCallback(() => {
    planToken.current += 1;
    discovering.current = false;
    setProbingTracks(false);
    setProbingStreamOptions(false);
    setTrackProbe(null);
    setSelectedAudioId(null);
    setSelectedSubtitleIds(new Set());
    setStreamOptions(null);
    setSelectedStreamOption(null);
  }, []);

  /**
   * Read the tracks of one page or manifest and adopt its defaults. One
   * function where there were three copies (initial probe, default language,
   * language switch).
   */
  const loadTracks = useCallback(async (request: { pageUrl: string; manifestUrl?: string }) => {
    if (!window.streamDock?.probeMediaTracks) return;
    const token = planToken.current;
    setProbingTracks(true);
    try {
      const result = await window.streamDock.probeMediaTracks(request);
      if (token !== planToken.current) return;
      if (!result?.success) return;
      setTrackProbe(result.data);
      const defaultSubs = result.data.subtitleTracks.filter((t) => t.isDefault).map((t) => t.id);
      if (defaultSubs.length > 0) setSelectedSubtitleIds(new Set(defaultSubs));
      setSelectedAudioId(defaultAudioTrackId(result.data));
    } catch {
      // Track details are optional: the download proceeds with the source's defaults.
    } finally {
      if (token === planToken.current) setProbingTracks(false);
    }
  }, []);

  const loadStreamOptions = useCallback(async (pageUrl: string) => {
    if (!window.streamDock?.probeStreamOptions) return;
    const token = planToken.current;
    discovering.current = true;
    setProbingStreamOptions(true);
    try {
      const result = await window.streamDock.probeStreamOptions(pageUrl);
      if (token !== planToken.current) return;
      if (result.success && result.options.length > 1) {
        setStreamOptions(result);
        const defaultManifestUrl = result.defaultOption?.manifestUrl || result.options[0].manifestUrl;
        setSelectedStreamOption(defaultManifestUrl);
        if (defaultManifestUrl !== pageUrl) void loadTracks({ pageUrl: defaultManifestUrl, manifestUrl: defaultManifestUrl });
      } else {
        setStreamOptions(null);
        setSelectedStreamOption(null);
      }
    } catch {
      if (token !== planToken.current) return;
      setStreamOptions(null);
      setSelectedStreamOption(null);
    } finally {
      if (token === planToken.current) {
        discovering.current = false;
        setProbingStreamOptions(false);
      }
    }
  }, [loadTracks]);

  /**
   * Switching language switches the whole stream, so the track list has to be
   * re-read for the new manifest — sub and dub are different files with their
   * own audio and subtitle tracks.
   */
  const selectStreamOption = useCallback((manifestUrl: string) => {
    setSelectedStreamOption(manifestUrl);
    void loadTracks({ pageUrl: manifestUrl, manifestUrl });
  }, [loadTracks]);

  const toggleSubtitleTrack = useCallback((id: string) => {
    setSelectedSubtitleIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return {
    planToken,
    reset,
    trackProbe,
    probingTracks,
    selectedAudioId,
    setSelectedAudioId,
    selectedSubtitleIds,
    setSelectedSubtitleIds,
    toggleSubtitleTrack,
    streamOptions,
    selectedStreamOption,
    selectStreamOption,
    probingStreamOptions,
    isDiscovering,
    loadTracks,
    loadStreamOptions,
  };
}

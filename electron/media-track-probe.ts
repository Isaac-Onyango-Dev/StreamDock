// Role: discover dubbed audio and subtitle tracks from manifests and yt-dlp metadata.

import log from 'electron-log';
import { buildPluginDirArgs, resolveYtDlpCommand } from './binary-resolver';
import { extractManifest } from './manifest-extractor';
import { fetchWithDeadline, removeTempFile, runProbeChild } from './probe-support';
import { getLanguageName, isOriginalLanguageHint, normalizeLanguageCode } from './language-registry';
import {
  parseManifestContent,
  type AudioTrackInfo,
  type ParsedManifestTracks,
  type QualityVariant,
  type SubtitleFormat,
  type SubtitleTrackInfo,
} from './manifest-parser';

export interface MediaTrackProbe {
  url: string;
  manifestUrl?: string;
  manifestType?: 'm3u8' | 'mpd';
  audioTracks: AudioTrackInfo[];
  subtitleTracks: SubtitleTrackInfo[];
  qualityOptions: QualityVariant[];
  defaultAudioLanguage?: string;
  originalAudioLanguage?: string;
  notes: string[];
  source: 'manifest' | 'ytdlp' | 'combined';
}

export interface ProbeMediaTracksRequest {
  pageUrl: string;
  manifestUrl?: string;
  referer?: string;
}

/**
 * A manifest is a few kilobytes; a server that has said nothing in this long
 * is not going to. The fetch had no deadline, so one silent CDN left the
 * track picker's spinner running forever.
 */
const MANIFEST_FETCH_TIMEOUT_MS = 20_000;
const YTDLP_TRACK_PROBE_TIMEOUT_MS = 25_000;

function mergeTracks(
  primary: ParsedManifestTracks | null,
  secondary: { audio: AudioTrackInfo[]; subs: SubtitleTrackInfo[] },
): { audio: AudioTrackInfo[]; subs: SubtitleTrackInfo[] } {
  const audio = [...(primary?.audioTracks || [])];
  const subs = [...(primary?.subtitleTracks || [])];
  const audioKeys = new Set(audio.map((t) => `${t.language}::${t.label}`));
  const subKeys = new Set(subs.map((t) => `${t.language}::${t.label}`));

  for (const track of secondary.audio) {
    const key = `${track.language}::${track.label}`;
    if (!audioKeys.has(key)) {
      audio.push(track);
      audioKeys.add(key);
    }
  }
  for (const track of secondary.subs) {
    const key = `${track.language}::${track.label}`;
    if (!subKeys.has(key)) {
      subs.push(track);
      subKeys.add(key);
    }
  }

  return { audio, subs };
}

function inferOriginalLanguage(audio: AudioTrackInfo[]): string | undefined {
  const original = audio.find((t) => t.isOriginal);
  if (original) return original.language;
  const japanese = audio.find((t) => normalizeLanguageCode(t.language) === 'ja');
  return japanese?.language;
}

function inferDefaultAudio(audio: AudioTrackInfo[]): string | undefined {
  return audio.find((t) => t.isDefault)?.language || audio[0]?.language;
}

function subtitleFormatFromExt(ext: string): SubtitleFormat {
  const lower = ext.toLowerCase();
  if (lower === 'vtt') return 'vtt';
  if (lower === 'srt') return 'srt';
  if (lower === 'ass') return 'ass';
  if (lower === 'ssa') return 'ssa';
  if (lower === 'ttml' || lower === 'dfxp') return 'ttml';
  return 'unknown';
}

interface YtDlpJson {
  subtitles?: Record<string, Array<{ ext?: string; url?: string; name?: string; format_id?: string }>>;
  automatic_captions?: Record<string, Array<{ ext?: string; url?: string; name?: string; format_id?: string }>>;
  formats?: Array<{
    format_id?: string;
    format?: string;
    ext?: string;
    acodec?: string;
    vcodec?: string;
    language?: string;
    format_note?: string;
    abr?: number;
    asr?: number;
    audio_channels?: number;
    tbr?: number;
    width?: number;
    height?: number;
    url?: string;
    manifest_url?: string;
  }>;
}

function labelForUnknownAudio(index: number, fmt: NonNullable<YtDlpJson['formats']>[number]): string {
  const hint = fmt.format_note || fmt.format || fmt.format_id;
  return hint && !/^unknown$/i.test(hint) ? `Audio Track ${index} (${hint})` : `Audio Track ${index}`;
}

function audioTrackKey(fmt: NonNullable<YtDlpJson['formats']>[number], fallbackIndex: number): string {
  const language = normalizeLanguageCode(fmt.language);
  const note = (fmt.format_note || fmt.format || '').toLowerCase().trim();
  if (language !== 'unknown') return `lang:${language}:${note}`;
  if (note) return `note:${note}`;
  return `format:${fmt.format_id || fallbackIndex}`;
}

async function probeWithYtDlp(
  url: string,
  signal?: AbortSignal,
): Promise<{ audio: AudioTrackInfo[]; subs: SubtitleTrackInfo[]; notes: string[] }> {
  const notes: string[] = [];
  const audio: AudioTrackInfo[] = [];
  const subs: SubtitleTrackInfo[] = [];

  let ytDlpCmd;
  try {
    ytDlpCmd = resolveYtDlpCommand();
  } catch {
    notes.push('yt-dlp unavailable for language probe.');
    return { audio, subs, notes };
  }

  const args = [
    ...ytDlpCmd.args,
    '-J',
    '--no-download',
    '--skip-download',
    '--no-warnings',
    ...buildPluginDirArgs(),
    '--',
    url,
  ];

  const result = await runProbeChild(ytDlpCmd.command, args, { timeoutMs: YTDLP_TRACK_PROBE_TIMEOUT_MS, signal });
  const jsonText = result.code === 0 && result.stdout.trim() ? result.stdout : null;

  if (!jsonText) {
    notes.push('yt-dlp metadata probe returned no data.');
    return { audio, subs, notes };
  }

  let data: YtDlpJson;
  try {
    data = JSON.parse(jsonText) as YtDlpJson;
  } catch {
    notes.push('yt-dlp metadata probe returned invalid JSON.');
    return { audio, subs, notes };
  }

  const audioTracksByKey = new Map<string, AudioTrackInfo>();
  let unknownAudioIndex = 1;
  for (const [index, fmt] of (data.formats || []).entries()) {
    if (!fmt.acodec || fmt.acodec === 'none') continue;
    const isAudioOnly = !fmt.vcodec || fmt.vcodec === 'none';
    if (!isAudioOnly && !fmt.language && !fmt.format_note) continue;

    const lang = normalizeLanguageCode(fmt.language);
    const key = audioTrackKey(fmt, index);
    if (audioTracksByKey.has(key)) continue;

    // Extractor-agnostic fallback: many HLS/generic extractors expose alternate
    // dubs as separate audio-only format IDs but leave `language` empty. Keep
    // those format IDs and surface neutral labels instead of hiding them.
    const label = lang === 'unknown'
      ? labelForUnknownAudio(unknownAudioIndex++, fmt)
      : getLanguageName(lang, fmt.format_note);

    audioTracksByKey.set(key, {
      id: `ytdlp-audio-${audioTracksByKey.size + 1}`,
      language: lang,
      formatId: fmt.format_id,
      label,
      name: fmt.format_note,
      isDefault: audioTracksByKey.size === 0,
      isOriginal: isOriginalLanguageHint(lang, fmt.format_note),
      isDub: /\bdub\b/i.test(fmt.format_note || ''),
      codec: fmt.acodec,
      bitrate: fmt.abr,
      uri: fmt.url,
      manifestUrl: fmt.manifest_url,
    });
  }
  audio.push(...audioTracksByKey.values());

  const addSubs = (
    bucket: Record<string, Array<{ ext?: string; url?: string; name?: string; format_id?: string }>> | undefined,
    auto: boolean,
  ) => {
    if (!bucket) return;
    for (const [langRaw, entries] of Object.entries(bucket)) {
      const language = normalizeLanguageCode(langRaw);
      const entry = entries[0];
      const ext = entry?.ext || 'unknown';
      subs.push({
        id: `ytdlp-sub-${subs.length + 1}`,
        language,
        formatId: entry?.format_id,
        label: `${getLanguageName(language)}${auto ? ' (auto)' : ''}`,
        format: subtitleFormatFromExt(ext),
        isDefault: false,
        uri: entry?.url,
      });
    }
  };

  addSubs(data.subtitles, false);
  addSubs(data.automatic_captions, true);

  if (audio.length > 0 || subs.length > 0) {
    notes.push('Merged yt-dlp format and subtitle metadata.');
  }

  return { audio, subs, notes };
}

async function probeManifestUrl(
  manifestUrl: string,
  referer: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ parsed: ParsedManifestTracks | null; notes: string[] }> {
  const notes: string[] = [];
  const { body } = await fetchWithDeadline(manifestUrl, {
    headers: { Accept: '*/*', ...(referer ? { Referer: referer } : {}) },
    timeoutMs: MANIFEST_FETCH_TIMEOUT_MS,
    signal,
  });
  if (!body) {
    notes.push('Could not fetch manifest for track parsing.');
    return { parsed: null, notes };
  }

  const parsed = parseManifestContent(body, manifestUrl);
  if (!parsed) {
    notes.push('Manifest fetched but no audio/subtitle tags were recognized.');
    return { parsed: null, notes };
  }

  notes.push(`Parsed ${parsed.audioTracks.length} audio and ${parsed.subtitleTracks.length} subtitle track(s) from ${parsed.manifestType.toUpperCase()}.`);
  return { parsed, notes };
}

/**
 * Describe the audio and subtitle tracks a page or manifest offers.
 *
 * Rejects with the signal's reason when `signal` aborts; any hidden window or
 * yt-dlp child it started is stopped first.
 */
export async function probeMediaTracks(request: ProbeMediaTracksRequest, signal?: AbortSignal): Promise<MediaTrackProbe> {
  signal?.throwIfAborted();
  const notes: string[] = [];
  let manifestUrl = request.manifestUrl;
  let referer = request.referer;
  let manifestType: 'm3u8' | 'mpd' | undefined;

  if (!manifestUrl) {
    const directType = request.pageUrl.match(/\.(m3u8|mpd)(\?|$)/i)?.[1]?.toLowerCase();
    if (directType === 'm3u8' || directType === 'mpd') {
      manifestUrl = request.pageUrl;
      manifestType = directType;
    } else {
      log.info(`[media-track-probe] Resolving manifest for ${request.pageUrl}`);
      const manifest = await extractManifest(request.pageUrl, undefined, signal);
      // Nothing here hands the cookie jar to anything — the manifest fetch and
      // the yt-dlp probe below both run without it — so it was simply left on
      // disk, one file per probe.
      removeTempFile(manifest?.cookiesFile);
      signal?.throwIfAborted();
      if (manifest) {
        manifestUrl = manifest.manifestUrl;
        referer = manifest.referer || referer;
        manifestType = manifest.type === 'mpd' ? 'mpd' : 'm3u8';
        notes.push('Manifest resolved via hidden browser probe.');
      } else {
        notes.push('No manifest URL found — falling back to yt-dlp metadata only.');
      }
    }
  }

  let parsed: ParsedManifestTracks | null = null;
  if (manifestUrl) {
    const manifestProbe = await probeManifestUrl(manifestUrl, referer || request.pageUrl, signal);
    signal?.throwIfAborted();
    notes.push(...manifestProbe.notes);
    parsed = manifestProbe.parsed;
    manifestType = parsed?.manifestType || manifestType;
  }

  const ytdlp = await probeWithYtDlp(manifestUrl || request.pageUrl, signal);
  notes.push(...ytdlp.notes);

  const merged = mergeTracks(parsed, ytdlp);
  const source: MediaTrackProbe['source'] =
    parsed && (ytdlp.audio.length > 0 || ytdlp.subs.length > 0) ? 'combined'
      : parsed ? 'manifest'
        : ytdlp.audio.length > 0 || ytdlp.subs.length > 0 ? 'ytdlp'
          : 'manifest';

  if (merged.audio.length === 0 && merged.subs.length === 0) {
    notes.push('No alternate audio or subtitle tracks detected for this source.');
  }

  return {
    url: request.pageUrl,
    manifestUrl,
    manifestType,
    audioTracks: merged.audio,
    subtitleTracks: merged.subs,
    qualityOptions: parsed?.qualityOptions || [],
    defaultAudioLanguage: inferDefaultAudio(merged.audio),
    originalAudioLanguage: inferOriginalLanguage(merged.audio),
    notes,
    source,
  };
}

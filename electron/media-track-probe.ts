// Role: discover dubbed audio and subtitle tracks from manifests and yt-dlp metadata.

import { net } from 'electron';
import { spawn } from 'child_process';
import log from 'electron-log';
import { buildPluginDirArgs, resolveYtDlpCommand } from './binary-resolver';
import { extractManifest } from './manifest-extractor';
import { getLanguageName, isOriginalLanguageHint, normalizeLanguageCode } from './language-registry';
import {
  parseManifestContent,
  type AudioTrackInfo,
  type ParsedManifestTracks,
  type SubtitleFormat,
  type SubtitleTrackInfo,
} from './manifest-parser';

export type DownloadPackagingMode =
  | 'video-only'
  | 'video-audio'
  | 'video-subs'
  | 'video-audio-subs'
  | 'video-multi-subs'
  | 'subs-only';

export interface MediaTrackProbe {
  url: string;
  manifestUrl?: string;
  manifestType?: 'm3u8' | 'mpd';
  audioTracks: AudioTrackInfo[];
  subtitleTracks: SubtitleTrackInfo[];
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

const SPOOF_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

function fetchText(url: string, referer?: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const request = net.request({
        method: 'GET',
        url,
        headers: {
          'User-Agent': SPOOF_UA,
          Accept: '*/*',
          ...(referer ? { Referer: referer } : {}),
        },
      });
      let body = '';
      request.on('response', (response) => {
        response.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        response.on('end', () => resolve(body || null));
        response.on('error', () => resolve(null));
      });
      request.on('error', () => resolve(null));
      request.end();
    } catch {
      resolve(null);
    }
  });
}

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
  subtitles?: Record<string, Array<{ ext?: string; url?: string }>>;
  automatic_captions?: Record<string, Array<{ ext?: string; url?: string }>>;
  formats?: Array<{ acodec?: string; vcodec?: string; language?: string; format_note?: string; abr?: number }>;
}

async function probeWithYtDlp(url: string): Promise<{ audio: AudioTrackInfo[]; subs: SubtitleTrackInfo[]; notes: string[] }> {
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

  const jsonText = await new Promise<string | null>((resolve) => {
    const child = spawn(ytDlpCmd.command, args, { windowsHide: true });
    let stdout = '';
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(null);
    }, 25_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 && stdout.trim() ? stdout : null));
  });

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

  const audioLangs = new Map<string, AudioTrackInfo>();
  for (const fmt of data.formats || []) {
    if (!fmt.acodec || fmt.acodec === 'none') continue;
    const lang = normalizeLanguageCode(fmt.language);
    if (audioLangs.has(lang)) continue;
    const label = getLanguageName(lang, fmt.format_note);
    audioLangs.set(lang, {
      id: `ytdlp-audio-${audioLangs.size + 1}`,
      language: lang,
      label,
      name: fmt.format_note,
      isDefault: audioLangs.size === 0,
      isOriginal: isOriginalLanguageHint(lang, fmt.format_note),
      isDub: /\bdub\b/i.test(fmt.format_note || ''),
      codec: fmt.acodec,
      bitrate: fmt.abr,
    });
  }
  audio.push(...audioLangs.values());

  const addSubs = (bucket: Record<string, Array<{ ext?: string; url?: string }>> | undefined, auto: boolean) => {
    if (!bucket) return;
    for (const [langRaw, entries] of Object.entries(bucket)) {
      const language = normalizeLanguageCode(langRaw);
      const entry = entries[0];
      const ext = entry?.ext || 'unknown';
      subs.push({
        id: `ytdlp-sub-${subs.length + 1}`,
        language,
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
  referer?: string,
): Promise<{ parsed: ParsedManifestTracks | null; notes: string[] }> {
  const notes: string[] = [];
  const body = await fetchText(manifestUrl, referer);
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

export async function probeMediaTracks(request: ProbeMediaTracksRequest): Promise<MediaTrackProbe> {
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
      const manifest = await extractManifest(request.pageUrl);
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
    const manifestProbe = await probeManifestUrl(manifestUrl, referer || request.pageUrl);
    notes.push(...manifestProbe.notes);
    parsed = manifestProbe.parsed;
    manifestType = parsed?.manifestType || manifestType;
  }

  const ytdlp = await probeWithYtDlp(manifestUrl || request.pageUrl);
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
    defaultAudioLanguage: inferDefaultAudio(merged.audio),
    originalAudioLanguage: inferOriginalLanguage(merged.audio),
    notes,
    source,
  };
}

export function resolvePackagingMode(input: {
  includeVideo: boolean;
  audioLanguage?: string;
  subtitleLanguages?: string[];
  subsOnly?: boolean;
}): DownloadPackagingMode {
  if (input.subsOnly) return 'subs-only';
  const hasAudio = Boolean(input.audioLanguage);
  const subCount = input.subtitleLanguages?.length || 0;
  if (!hasAudio && subCount === 0) return 'video-only';
  if (hasAudio && subCount === 0) return 'video-audio';
  if (!hasAudio && subCount === 1) return 'video-subs';
  if (hasAudio && subCount === 1) return 'video-audio-subs';
  if (subCount > 1) return 'video-multi-subs';
  return 'video-subs';
}

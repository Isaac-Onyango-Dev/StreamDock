// Role: parse HLS and DASH manifests for audio / subtitle track metadata.

import { dedupeKeyForLanguage, getLanguageName, isDubLanguageHint, isOriginalLanguageHint, normalizeLanguageCode } from './language-registry';

export type SubtitleFormat = 'vtt' | 'srt' | 'ass' | 'ssa' | 'ttml' | 'unknown';

export interface AudioTrackInfo {
  id: string;
  language: string;
  label: string;
  formatId?: string;
  name?: string;
  isDefault: boolean;
  isOriginal: boolean;
  isDub: boolean;
  codec?: string;
  bitrate?: number;
  groupId?: string;
  uri?: string;
  manifestUrl?: string;
}

export interface SubtitleTrackInfo {
  id: string;
  language: string;
  label: string;
  formatId?: string;
  format: SubtitleFormat;
  isDefault: boolean;
  groupId?: string;
  uri?: string;
  manifestUrl?: string;
}

export interface QualityVariant {
  height: number;
  label: string;
  width?: number;
  bandwidth?: number;
  uri?: string;
}

export interface ParsedManifestTracks {
  manifestType: 'm3u8' | 'mpd';
  audioTracks: AudioTrackInfo[];
  subtitleTracks: SubtitleTrackInfo[];
  qualityOptions: QualityVariant[];
}

function parseHlsAttributes(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const body = line.replace(/^#EXT-X-[A-Z0-9-]+:/i, '');
  const re = /([A-Z0-9-]+)=("([^"]*)"|([^,]*))/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    attrs[match[1].toLowerCase()] = (match[3] ?? match[4] ?? '').trim();
  }
  return attrs;
}

function subtitleFormatFromUri(uri: string): SubtitleFormat {
  const lower = uri.toLowerCase();
  if (lower.includes('.vtt') || lower.includes('text/vtt')) return 'vtt';
  if (lower.includes('.srt')) return 'srt';
  if (lower.includes('.ass')) return 'ass';
  if (lower.includes('.ssa')) return 'ssa';
  if (lower.includes('.ttml') || lower.includes('.dfxp')) return 'ttml';
  return 'unknown';
}

function resolveManifestUrl(baseUrl: string, relative: string): string {
  try {
    return new URL(relative, baseUrl).toString();
  } catch {
    return relative;
  }
}

export function parseHlsManifest(text: string, manifestUrl: string): ParsedManifestTracks {
  const audioTracks: AudioTrackInfo[] = [];
  const subtitleTracks: SubtitleTrackInfo[] = [];
  const qualityByHeight = new Map<number, QualityVariant>();
  const seenAudio = new Set<string>();
  const seenSubs = new Set<string>();
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseHlsAttributes(line);
      const resolution = attrs.resolution?.match(/(\d+)x(\d+)/i);
      const width = resolution ? Number(resolution[1]) : undefined;
      const height = resolution ? Number(resolution[2]) : undefined;
      if (height && Number.isFinite(height) && height > 0) {
        let uri: string | undefined;
        for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
          const nextLine = lines[nextIndex].trim();
          if (!nextLine || nextLine.startsWith('#')) continue;
          uri = resolveManifestUrl(manifestUrl, nextLine);
          break;
        }
        const bandwidth = attrs.bandwidth ? Number(attrs.bandwidth) : undefined;
        const existing = qualityByHeight.get(height);
        if (!existing || (bandwidth || 0) > (existing.bandwidth || 0)) {
          qualityByHeight.set(height, {
            height,
            width,
            bandwidth,
            uri,
            label: `${height}p`,
          });
        }
      }
      continue;
    }

    if (!line.startsWith('#EXT-X-MEDIA:')) continue;

    const attrs = parseHlsAttributes(line);
    const type = (attrs.type || '').toUpperCase();
    const language = normalizeLanguageCode(attrs.language);
    const name = attrs.name || attrs.title;
    const groupId = attrs['group-id'];
    const isDefault = (attrs.default || '').toUpperCase() === 'YES';
    const uri = attrs.uri ? resolveManifestUrl(manifestUrl, attrs.uri) : undefined;

    if (type === 'AUDIO') {
      const key = dedupeKeyForLanguage(language, name, groupId);
      if (seenAudio.has(key)) continue;
      seenAudio.add(key);
      audioTracks.push({
        id: `audio-${audioTracks.length + 1}`,
        language,
        label: getLanguageName(language, name),
        name,
        isDefault,
        isOriginal: isOriginalLanguageHint(language, name),
        isDub: isDubLanguageHint(name),
        groupId,
        uri,
        manifestUrl,
      });
    }

    if (type === 'SUBTITLES') {
      const key = dedupeKeyForLanguage(language, name, groupId);
      if (seenSubs.has(key)) continue;
      seenSubs.add(key);
      subtitleTracks.push({
        id: `sub-${subtitleTracks.length + 1}`,
        language,
        label: getLanguageName(language, name),
        format: subtitleFormatFromUri(uri || name || ''),
        isDefault,
        groupId,
        uri,
        manifestUrl,
      });
    }
  }

  // Variant streams referencing AUDIO groups without EXT-X-MEDIA
  if (audioTracks.length === 0) {
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
      const langMatch = line.match(/LANGUAGE="?([^,"]+)"?/i);
      if (!langMatch) continue;
      const language = normalizeLanguageCode(langMatch[1]);
      const key = dedupeKeyForLanguage(language);
      if (seenAudio.has(key)) continue;
      seenAudio.add(key);
      audioTracks.push({
        id: `audio-${audioTracks.length + 1}`,
        language,
        label: getLanguageName(language),
        isDefault: audioTracks.length === 0,
        isOriginal: isOriginalLanguageHint(language),
        isDub: false,
        manifestUrl,
      });
    }
  }

  return {
    manifestType: 'm3u8',
    audioTracks,
    subtitleTracks,
    qualityOptions: Array.from(qualityByHeight.values()).sort((a, b) => b.height - a.height),
  };
}

function xmlAttr(tag: string, name: string): string | undefined {
  const re = new RegExp(`${name}="([^"]*)"`, 'i');
  return tag.match(re)?.[1];
}

export function parseDashManifest(text: string, manifestUrl: string): ParsedManifestTracks {
  const audioTracks: AudioTrackInfo[] = [];
  const subtitleTracks: SubtitleTrackInfo[] = [];
  const qualityByHeight = new Map<number, QualityVariant>();
  const seenAudio = new Set<string>();
  const seenSubs = new Set<string>();

  const adaptationSets = text.match(/<AdaptationSet\b[^>]*>[\s\S]*?<\/AdaptationSet>/gi) || [];

  for (const block of adaptationSets) {
    const openTag = block.match(/<AdaptationSet\b[^>]*>/i)?.[0] || '';
    const mime = (xmlAttr(openTag, 'mimeType') || xmlAttr(openTag, 'contentType') || '').toLowerCase();
    const lang = normalizeLanguageCode(xmlAttr(openTag, 'lang') || xmlAttr(openTag, 'language'));
    const isAudio = mime.includes('audio');
    const isText = mime.includes('text') || mime.includes('subtitle') || mime.includes('caption');
    const isVideo = mime.includes('video');

    const representations = block.match(/<Representation\b[^>]*\/?>/gi) || [];
    let codec: string | undefined;
    let bitrate: number | undefined;
    let uri: string | undefined;

    for (const rep of representations) {
      codec = codec || xmlAttr(rep, 'codecs');
      const bw = xmlAttr(rep, 'bandwidth');
      if (bw) bitrate = parseInt(bw, 10);
      const baseUrl = block.match(/<BaseURL>([^<]+)<\/BaseURL>/i)?.[1];
      if (baseUrl) uri = resolveManifestUrl(manifestUrl, baseUrl.trim());
      if (isVideo) {
        const height = Number(xmlAttr(rep, 'height'));
        if (Number.isFinite(height) && height > 0) {
          const width = Number(xmlAttr(rep, 'width'));
          const bandwidth = bw ? parseInt(bw, 10) : undefined;
          const existing = qualityByHeight.get(height);
          if (!existing || (bandwidth || 0) > (existing.bandwidth || 0)) {
            qualityByHeight.set(height, {
              height,
              width: Number.isFinite(width) && width > 0 ? width : undefined,
              bandwidth,
              uri,
              label: `${height}p`,
            });
          }
        }
      }
    }

    if (isAudio) {
      const key = dedupeKeyForLanguage(lang, undefined, xmlAttr(openTag, 'id'));
      if (seenAudio.has(key)) continue;
      seenAudio.add(key);
      audioTracks.push({
        id: `audio-${audioTracks.length + 1}`,
        language: lang,
        label: getLanguageName(lang),
        isDefault: (xmlAttr(openTag, 'default') || '').toLowerCase() === 'true' || audioTracks.length === 0,
        isOriginal: isOriginalLanguageHint(lang),
        isDub: false,
        codec,
        bitrate,
        groupId: xmlAttr(openTag, 'id'),
        uri,
        manifestUrl,
      });
    }

    if (isText) {
      const key = dedupeKeyForLanguage(lang, undefined, xmlAttr(openTag, 'id'));
      if (seenSubs.has(key)) continue;
      seenSubs.add(key);
      subtitleTracks.push({
        id: `sub-${subtitleTracks.length + 1}`,
        language: lang,
        label: getLanguageName(lang),
        format: subtitleFormatFromUri(`${mime} ${uri || ''}`),
        isDefault: (xmlAttr(openTag, 'default') || '').toLowerCase() === 'true',
        groupId: xmlAttr(openTag, 'id'),
        uri,
        manifestUrl,
      });
    }
  }

  return {
    manifestType: 'mpd',
    audioTracks,
    subtitleTracks,
    qualityOptions: Array.from(qualityByHeight.values()).sort((a, b) => b.height - a.height),
  };
}

export function parseManifestContent(text: string, manifestUrl: string): ParsedManifestTracks | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('#EXTM3U') || trimmed.includes('#EXT-X-STREAM-INF')) {
    return parseHlsManifest(trimmed, manifestUrl);
  }
  if (trimmed.includes('<MPD') || trimmed.includes('urn:mpeg:dash')) {
    return parseDashManifest(trimmed, manifestUrl);
  }
  return null;
}

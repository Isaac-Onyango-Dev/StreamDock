// Role: parse HLS and DASH manifests for audio / subtitle track metadata.

import { dedupeKeyForLanguage, getLanguageName, isDubLanguageHint, isOriginalLanguageHint, normalizeLanguageCode } from './language-registry';

export type SubtitleFormat = 'vtt' | 'srt' | 'ass' | 'ssa' | 'ttml' | 'unknown';

export interface AudioTrackInfo {
  id: string;
  language: string;
  label: string;
  name?: string;
  isDefault: boolean;
  isOriginal: boolean;
  isDub: boolean;
  codec?: string;
  bitrate?: number;
  groupId?: string;
  uri?: string;
}

export interface SubtitleTrackInfo {
  id: string;
  language: string;
  label: string;
  format: SubtitleFormat;
  isDefault: boolean;
  groupId?: string;
  uri?: string;
}

export interface ParsedManifestTracks {
  manifestType: 'm3u8' | 'mpd';
  audioTracks: AudioTrackInfo[];
  subtitleTracks: SubtitleTrackInfo[];
}

function parseHlsAttributes(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const body = line.replace(/^#EXT-X-MEDIA:/i, '');
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
  const seenAudio = new Set<string>();
  const seenSubs = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
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
      });
    }
  }

  // Variant streams referencing AUDIO groups without EXT-X-MEDIA
  if (audioTracks.length === 0) {
    for (const rawLine of text.split(/\r?\n/)) {
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
      });
    }
  }

  return { manifestType: 'm3u8', audioTracks, subtitleTracks };
}

function xmlAttr(tag: string, name: string): string | undefined {
  const re = new RegExp(`${name}="([^"]*)"`, 'i');
  return tag.match(re)?.[1];
}

export function parseDashManifest(text: string, manifestUrl: string): ParsedManifestTracks {
  const audioTracks: AudioTrackInfo[] = [];
  const subtitleTracks: SubtitleTrackInfo[] = [];
  const seenAudio = new Set<string>();
  const seenSubs = new Set<string>();

  const adaptationSets = text.match(/<AdaptationSet\b[^>]*>[\s\S]*?<\/AdaptationSet>/gi) || [];

  for (const block of adaptationSets) {
    const openTag = block.match(/<AdaptationSet\b[^>]*>/i)?.[0] || '';
    const mime = (xmlAttr(openTag, 'mimeType') || xmlAttr(openTag, 'contentType') || '').toLowerCase();
    const lang = normalizeLanguageCode(xmlAttr(openTag, 'lang') || xmlAttr(openTag, 'language'));
    const isAudio = mime.includes('audio');
    const isText = mime.includes('text') || mime.includes('subtitle') || mime.includes('caption');

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
      });
    }
  }

  return { manifestType: 'mpd', audioTracks, subtitleTracks };
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

const FLAGS: Record<string, string> = {
  en: '🇺🇸', ja: '🇯🇵', es: '🇪🇸', fr: '🇫🇷', de: '🇩🇪', pt: '🇧🇷',
  ar: '🇸🇦', hi: '🇮🇳', ko: '🇰🇷', zh: '🇨🇳', it: '🇮🇹', ru: '🇷🇺', id: '🇮🇩',
};

export function languageFlag(code: string): string {
  const base = code.toLowerCase().split('-')[0];
  return FLAGS[base] || '🌐';
}

import type { DownloadPackagingMode } from './types';

export function computePackagingMode(input: {
  subsOnly: boolean;
  audioLanguage?: string;
  subtitleLanguages: string[];
}): DownloadPackagingMode {
  if (input.subsOnly) return 'subs-only';
  const subCount = input.subtitleLanguages.length;
  const hasAudio = Boolean(input.audioLanguage);
  if (!hasAudio && subCount === 0) return 'video-only';
  if (hasAudio && subCount === 0) return 'video-audio';
  if (!hasAudio && subCount === 1) return 'video-subs';
  if (hasAudio && subCount === 1) return 'video-audio-subs';
  if (subCount > 1) return 'video-multi-subs';
  return 'video-subs';
}

export function describePackagingMode(mode: string): string {
  switch (mode) {
    case 'video-only': return 'Video only';
    case 'video-audio': return 'Video + selected dub';
    case 'video-subs': return 'Video + subtitles';
    case 'video-audio-subs': return 'Video + dub + subtitles';
    case 'video-multi-subs': return 'Video + multiple subtitles';
    case 'subs-only': return 'Subtitles only';
    default: return mode;
  }
}

import { describe, it, expect } from 'vitest';
import { computePackagingMode } from './languages';

describe('languages', () => {
  describe('computePackagingMode', () => {
    it('returns subs-only when subsOnly is true', () => {
      expect(computePackagingMode({ subsOnly: true, subtitleLanguages: [] })).toBe('subs-only');
      expect(computePackagingMode({ subsOnly: true, audioLanguage: 'en', subtitleLanguages: ['en'] })).toBe('subs-only');
    });

    it('returns video-only when no audio or subtitles', () => {
      expect(computePackagingMode({ subsOnly: false, subtitleLanguages: [] })).toBe('video-only');
      expect(computePackagingMode({ subsOnly: false, audioLanguage: undefined, subtitleLanguages: [] })).toBe('video-only');
    });

    it('returns video-audio when only audio language specified', () => {
      expect(computePackagingMode({ subsOnly: false, audioLanguage: 'en', subtitleLanguages: [] })).toBe('video-audio');
      expect(computePackagingMode({ subsOnly: false, audioLanguage: 'ja', subtitleLanguages: [] })).toBe('video-audio');
    });

    it('returns video-subs when only one subtitle language', () => {
      expect(computePackagingMode({ subsOnly: false, subtitleLanguages: ['en'] })).toBe('video-subs');
    });

    it('returns video-audio-subs when audio and one subtitle', () => {
      expect(computePackagingMode({ subsOnly: false, audioLanguage: 'en', subtitleLanguages: ['en'] })).toBe('video-audio-subs');
    });

    it('returns video-multi-subs when multiple subtitles', () => {
      expect(computePackagingMode({ subsOnly: false, subtitleLanguages: ['en', 'ja'] })).toBe('video-multi-subs');
      expect(computePackagingMode({ subsOnly: false, audioLanguage: 'en', subtitleLanguages: ['en', 'ja'] })).toBe('video-multi-subs');
    });
  });
});
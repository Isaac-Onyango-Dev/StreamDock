import { describe, it, expect } from 'vitest';
import { inferModeFromText } from './url-routing';

describe('url-routing', () => {
  describe('inferModeFromText', () => {
    it('returns stream for manifest URLs', () => {
      expect(inferModeFromText('https://example.com/video.m3u8')).toBe('stream');
      expect(inferModeFromText('https://example.com/manifest.mpd')).toBe('stream');
    });

    it('returns stream for known live hosts', () => {
      expect(inferModeFromText('https://twitch.tv/channel')).toBe('stream');
      expect(inferModeFromText('https://kick.com/channel')).toBe('stream');
      expect(inferModeFromText('https://trovo.live/channel')).toBe('stream');
    });

    it('returns stream for YouTube live', () => {
      expect(inferModeFromText('https://youtube.com/live/abc123')).toBe('stream');
    });

    it('returns video for everything else', () => {
      expect(inferModeFromText('https://youtube.com/watch?v=123')).toBe('video');
      expect(inferModeFromText('https://example.com/video')).toBe('video');
      expect(inferModeFromText('https://anikoto.cz/watch/123')).toBe('video');
    });
  });
});
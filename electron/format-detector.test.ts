import { describe, it, expect } from 'vitest';
import { detectFormat, buildFormatArgs } from './format-detector';

describe('format-detector', () => {
  describe('detectFormat', () => {
    it('detects HLS from .m3u8 extension', () => {
      const result = detectFormat('https://example.com/video.m3u8');
      expect(result.format).toBe('hls');
      expect(result.isLive).toBe(false);
    });

    it('detects HLS from /hls/ path', () => {
      const result = detectFormat('https://example.com/hls/stream.m3u8');
      expect(result.format).toBe('hls');
    });

    it('detects DASH from .mpd extension', () => {
      const result = detectFormat('https://example.com/manifest.mpd');
      expect(result.format).toBe('dash');
    });

    it('detects direct MP4', () => {
      const result = detectFormat('https://example.com/video.mp4');
      expect(result.format).toBe('mp4');
      expect(result.requiresRange).toBe(true);
    });

    it('detects direct MKV', () => {
      const result = detectFormat('https://example.com/video.mkv');
      expect(result.format).toBe('mkv');
      expect(result.requiresRange).toBe(true);
    });

    it('detects direct WebM', () => {
      const result = detectFormat('https://example.com/video.webm');
      expect(result.format).toBe('webm');
      expect(result.requiresRange).toBe(true);
    });

    it('detects audio files', () => {
      for (const ext of ['.mp3', '.m4a', '.opus', '.flac', '.wav', '.aac']) {
        const result = detectFormat(`https://example.com/audio${ext}`);
        expect(result.format).toBe('audio');
        expect(result.requiresRange).toBe(true);
      }
    });

    it('detects fMP4 from patterns', () => {
      const result = detectFormat('https://example.com/fragment.mp4');
      expect(result.format).toBe('fmp4');
    });

    it('detects Twitch live streams', () => {
      const result = detectFormat('https://twitch.tv/channel');
      expect(result.format).toBe('live');
      expect(result.isLive).toBe(true);
      expect(result.liveMessage).toContain('Live stream');
    });

    it('detects YouTube Live', () => {
      const result = detectFormat('https://youtube.com/live/abc123');
      expect(result.format).toBe('live');
      expect(result.isLive).toBe(true);
      expect(result.liveMessage).toContain('YouTube Live');
    });

    it('returns unknown for unrecognized URLs', () => {
      const result = detectFormat('https://example.com/watch?v=123');
      expect(result.format).toBe('unknown');
      expect(result.isLive).toBe(false);
    });

    it('handles invalid URLs gracefully', () => {
      const result = detectFormat('not a url');
      expect(result.format).toBe('unknown');
    });
  });

  describe('buildFormatArgs', () => {
    it('HLS: uses hls-prefer-native', () => {
      const args = buildFormatArgs({ format: 'hls', isLive: false, requiresRange: false });
      expect(args).toContain('--hls-use-mpegts');
      expect(args).toContain('--hls-prefer-native');
    });

    it('DASH: adds merge-output-format mp4', () => {
      const args = buildFormatArgs({ format: 'dash', isLive: false, requiresRange: false });
      expect(args).toContain('--merge-output-format');
      expect(args).toContain('mp4');
    });

    it('Direct files: uses concurrent-fragments', () => {
      const args = buildFormatArgs({ format: 'mp4', isLive: false, requiresRange: true });
      expect(args).toContain('--concurrent-fragments');
      expect(args).toContain('4');
    });

    it('Audio: extracts to mp3', () => {
      const args = buildFormatArgs({ format: 'audio', isLive: false, requiresRange: true });
      expect(args).toContain('-x');
      expect(args).toContain('--audio-format');
      expect(args).toContain('mp3');
    });

    it('Live: uses live-from-start', () => {
      const args = buildFormatArgs({ format: 'live', isLive: true, requiresRange: false });
      expect(args).toContain('--live-from-start');
      expect(args).toContain('--hls-use-mpegts');
    });

    it('Quality parameter overrides format selection', () => {
      const args = buildFormatArgs(
        { format: 'hls', isLive: false, requiresRange: false },
        'bestvideo[height<=720]+bestaudio'
      );
      expect(args).toContain('-f');
      expect(args).toContain('bestvideo[height<=720]+bestaudio');
    });
  });
});
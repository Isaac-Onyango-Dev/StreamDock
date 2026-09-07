import { describe, it, expect } from 'vitest';
import { analyzeUrl, getProbeStrategy, MANIFEST_PROBE_HOSTS, ANIME_HOSTS, REFERENCE_HOSTS } from './url-router';

describe('url-router', () => {
  describe('analyzeUrl', () => {
    it('throws on invalid URL', () => {
      expect(() => analyzeUrl('not a url')).toThrow('Enter a valid URL');
      expect(() => analyzeUrl('ftp://example.com')).toThrow('Only http and https');
    });

    it('detects manifest URLs as stream', () => {
      const result = analyzeUrl('https://example.com/video.m3u8');
      expect(result.suggestedMode).toBe('stream');
      expect(result.reason).toContain('Manifest URL');
    });

    it('detects reference hosts', () => {
      const result = analyzeUrl('https://everythingmoe.com/anime/one-piece');
      expect(result.suggestedMode).toBe('video');
      expect(result.reason).toContain('Reference index');
    });

    it('does not treat everythingmoe as an actual streaming/manifest-probe/anime source', () => {
      // Regression test: everythingmoe.com/.org must be reachable ONLY via
      // REFERENCE_HOSTS — it was previously also listed in manifestProbeHosts
      // and animeHosts, which let download-engine.ts and playlist-inspector.ts
      // treat it as a real, directly-downloadable content host.
      expect(REFERENCE_HOSTS()).toContain('everythingmoe.com');
      expect(REFERENCE_HOSTS()).toContain('everythingmoe.org');
      expect(MANIFEST_PROBE_HOSTS()).not.toContain('everythingmoe.com');
      expect(MANIFEST_PROBE_HOSTS()).not.toContain('everythingmoe.org');
      expect(ANIME_HOSTS()).not.toContain('everythingmoe.com');
      expect(ANIME_HOSTS()).not.toContain('everythingmoe.org');
    });

    it('detects known stream hosts', () => {
      for (const host of ['twitch.tv', 'kick.com', 'trovo.live']) {
        const result = analyzeUrl(`https://${host}/channel`);
        expect(result.suggestedMode).toBe('stream');
        expect(result.reason).toContain('Known live streaming host');
      }
    });

    it('detects plugin extractor hosts', () => {
      for (const host of ['anikoto.cz', 'animepahe.com', 'aniwatchtv.to']) {
        const result = analyzeUrl(`https://${host}/watch/123`);
        expect(result.suggestedMode).toBe('video');
        expect(result.reason).toContain('Plugin-backed');
      }
    });

    it('detects manifest probe hosts', () => {
      for (const host of ['anidap.se', 'animedao.watch', 'hianime.to']) {
        const result = analyzeUrl(`https://${host}/watch/123`);
        expect(result.suggestedMode).toBe('stream');
        expect(result.reason).toContain('probed for a manifest');
      }
    });

    it('detects Spotify URLs', () => {
      const result = analyzeUrl('https://open.spotify.com/track/123');
      expect(result.suggestedMode).toBe('video');
      expect(result.reason).toContain('Spotify DRM');
    });

    it('detects YouTube Live', () => {
      const result = analyzeUrl('https://youtube.com/live/abc123');
      expect(result.suggestedMode).toBe('stream');
      expect(result.reason).toContain('YouTube live');
    });

    it('defaults to video for unknown hosts', () => {
      const result = analyzeUrl('https://example.com/video');
      expect(result.suggestedMode).toBe('video');
      expect(result.reason).toBe('Standard media URL.');
    });

    it('normalizes host (removes www)', () => {
      const result = analyzeUrl('https://www.youtube.com/watch?v=123');
      expect(result.host).toBe('youtube.com');
    });
  });

  describe('getProbeStrategy', () => {
    it('returns ytdlp for supported hosts', () => {
      expect(getProbeStrategy('https://youtube.com/watch?v=123')).toBe('ytdlp');
      expect(getProbeStrategy('https://vimeo.com/123')).toBe('ytdlp');
      expect(getProbeStrategy('https://tiktok.com/@user/video/123')).toBe('ytdlp');
    });

    it('returns browser for unsupported hosts', () => {
      expect(getProbeStrategy('https://anikoto.cz/watch/123')).toBe('browser');
      expect(getProbeStrategy('https://unknown.site/video')).toBe('browser');
    });

    it('handles invalid URLs gracefully', () => {
      expect(getProbeStrategy('not a url')).toBe('browser');
    });
  });
});
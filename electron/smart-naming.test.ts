import { describe, it, expect } from 'vitest';
import { sanitizeName, buildOutputTemplate } from './smart-naming';

describe('smart-naming', () => {
  describe('sanitizeName', () => {
    it('collapses runs of invalid filesystem characters into one underscore', () => {
      expect(sanitizeName('file:name')).toBe('file_name');
      expect(sanitizeName('file/name')).toBe('file_name');
      expect(sanitizeName('file\\name')).toBe('file_name');
      expect(sanitizeName('file*name')).toBe('file_name');
      expect(sanitizeName('file?name')).toBe('file_name');
      expect(sanitizeName('file"name')).toBe('file_name');
      expect(sanitizeName('file<name>')).toBe('file_name_');
      expect(sanitizeName('file|name')).toBe('file_name');
      // A RUN of illegal chars collapses to a single underscore, not one per char.
      expect(sanitizeName('Ep<1>:Name')).toBe('Ep_1_Name');
    });

    it('trims whitespace', () => {
      expect(sanitizeName('  hello  ')).toBe('hello');
      expect(sanitizeName('\t\nhello\t\n')).toBe('hello');
    });

    it('truncates to 150 UTF-8 bytes', () => {
      const longAscii = 'a'.repeat(200);
      expect(sanitizeName(longAscii).length).toBe(150);

      const emoji = '🎉'.repeat(100);
      const result = sanitizeName(emoji);
      const bytes = Buffer.byteLength(result, 'utf-8');
      expect(bytes).toBeLessThanOrEqual(150);
    });

    it('returns "Download" for empty or all-illegal-character input', () => {
      expect(sanitizeName('')).toBe('Download');
      expect(sanitizeName('   ')).toBe('Download');
      expect(sanitizeName('\\/:*?"<>|')).toBe('Download');
      // Entirely illegal characters collapse to a single "_", which itself
      // carries no information — also falls back to 'Download'.
      expect(sanitizeName('///')).toBe('Download');
    });

    it('handles mixed valid and invalid chars', () => {
      expect(sanitizeName('My Video: Episode 1')).toBe('My Video_ Episode 1');
      expect(sanitizeName('Season 1/Episode 1')).toBe('Season 1_Episode 1');
    });
  });

  describe('buildOutputTemplate', () => {
    it('branch 1: stream mode uses timestamp template, no folder', () => {
      const result = buildOutputTemplate({ mode: 'stream' });
      expect(result).toBe('StreamDock Stream %(upload_date>%Y-%m-%d)s %(epoch>%H-%M-%S)s.%(ext)s');
    });

    it('branch 2: multi-episode with folderHint uses "Episode (N)" naming, optional season nesting', () => {
      const result = buildOutputTemplate({
        mode: 'video',
        isPlaylist: true,
        folderHint: 'My Series',
      });
      expect(result).toBe('My Series/%(season_number&Season %d/|)sEpisode (%(playlist_index)d).%(ext)s');
    });

    it('branch 2: playlist without folderHint falls back to playlist_title for the folder', () => {
      const result = buildOutputTemplate({
        mode: 'video',
        isPlaylist: true,
      });
      expect(result).toBe('%(playlist_title).150B/%(season_number&Season %d/|)sEpisode (%(playlist_index)d).%(ext)s');
    });

    it('branch 2: non-empty playlistItems alone triggers multi-item mode', () => {
      const result = buildOutputTemplate({
        mode: 'video',
        playlistItems: '1-5',
      });
      expect(result).toContain('Episode (%(playlist_index)d)');
    });

    it('branch 2: season folder is not zero-padded, per spec example ("Season 1")', () => {
      const result = buildOutputTemplate({
        mode: 'video',
        folderHint: 'My Show',
      });
      expect(result).toBe('My Show/%(season_number&Season %d/|)sEpisode (%(playlist_index)d).%(ext)s');
    });

    it('branch 3: single video no context uses plain title, no folder', () => {
      const result = buildOutputTemplate({ mode: 'video' });
      expect(result).toBe('%(title).150B.%(ext)s');
    });

    it('titleHint takes precedence over forcedTitle, and skips season/episode-number templating', () => {
      const result = buildOutputTemplate({
        mode: 'video',
        folderHint: 'Series',
        titleHint: 'Episode 1 - Title',
        forcedTitle: 'Fallback Title',
      });
      expect(result).toBe('Series/Episode 1 - Title.%(ext)s');
    });

    it('sanitizes folderHint and titleHint', () => {
      const result = buildOutputTemplate({
        mode: 'video',
        folderHint: 'My:Series*',
        titleHint: 'Ep<1>:Name',
      });
      expect(result).toBe('My_Series_/Ep_1_Name.%(ext)s');
    });

    it('resolved titleHint inside a playlist uses the literal title, not a numbered prefix', () => {
      const result = buildOutputTemplate({
        mode: 'video',
        isPlaylist: true,
        folderHint: 'Series',
        titleHint: 'Episode 1',
      });
      expect(result).toBe('Series/Episode 1.%(ext)s');
    });

    it('a resolved title with no folderHint falls back to the resolved title as the folder', () => {
      const result = buildOutputTemplate({
        mode: 'video',
        isPlaylist: true,
        titleHint: 'One Piece - Episode 5 - Storm',
      });
      expect(result).toBe('One Piece - Episode 5 - Storm/One Piece - Episode 5 - Storm.%(ext)s');
    });
  });
});

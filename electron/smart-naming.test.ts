import { describe, it, expect } from 'vitest';
import { isAbsolute } from 'path';
import { sanitizeName, buildOutputTemplate, isConfirmedMultiItem } from './smart-naming';

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
    it('a live stream keeps the timestamp name and is never put in a folder', () => {
      const result = buildOutputTemplate({ mode: 'stream' });
      expect(result).toBe('StreamDock Stream %(upload_date>%Y-%m-%d)s %(epoch>%H-%M-%S)s.%(ext)s');
    });

    it('a single video is just <title>.<ext> — no folder, no numbering', () => {
      expect(buildOutputTemplate({ mode: 'video' })).toBe('%(title).150B.%(ext)s');
    });

    it('a single video with a known title uses that title verbatim', () => {
      const result = buildOutputTemplate({ mode: 'video', titleHint: 'Me at the zoo' });
      expect(result).toBe('Me at the zoo.%(ext)s');
    });

    it('a confirmed playlist puts real per-item titles inside a named folder', () => {
      const result = buildOutputTemplate({
        mode: 'video',
        isPlaylist: true,
        folderHint: 'My Series',
      });
      expect(result).toBe('My Series/%(title).150B.%(ext)s');
    });

    it('a playlist with no folder name falls back to the playlist title', () => {
      const result = buildOutputTemplate({ mode: 'video', isPlaylist: true });
      expect(result).toBe('%(playlist_title).150B/%(title).150B.%(ext)s');
    });

    it('a --playlist-items selection is a playlist, so it gets a folder', () => {
      const result = buildOutputTemplate({ mode: 'video', playlistItems: '1-5' });
      expect(result).toBe('%(playlist_title).150B/%(title).150B.%(ext)s');
    });

    it('never emits the abolished Episode (N) or Season templating', () => {
      const everyShape = [
        buildOutputTemplate({ mode: 'video' }),
        buildOutputTemplate({ mode: 'video', isPlaylist: true }),
        buildOutputTemplate({ mode: 'video', playlistItems: '1-5' }),
        buildOutputTemplate({ mode: 'video', folderHint: 'Series' }),
        buildOutputTemplate({ mode: 'video', folderHint: 'Series', titleHint: 'Ep 1' }),
      ];
      for (const template of everyShape) {
        expect(template).not.toContain('Episode (');
        expect(template).not.toContain('playlist_index');
        expect(template).not.toContain('season_number');
        expect(template).not.toContain('Season ');
      }
    });

    it('titleHint takes precedence over the engine-derived forcedTitle', () => {
      const result = buildOutputTemplate({
        mode: 'video',
        folderHint: 'Series',
        titleHint: 'Episode 1 - Title',
        forcedTitle: 'Fallback Title',
      });
      expect(result).toBe('Series/Episode 1 - Title.%(ext)s');
    });

    it('falls back to forcedTitle when the UI supplied no title', () => {
      const result = buildOutputTemplate({ mode: 'video', forcedTitle: 'Fallback Title' });
      expect(result).toBe('Fallback Title.%(ext)s');
    });

    it('sanitizes folderHint and titleHint', () => {
      const result = buildOutputTemplate({
        mode: 'video',
        folderHint: 'My:Series*',
        titleHint: 'Ep<1>:Name',
      });
      expect(result).toBe('My_Series_/Ep_1_Name.%(ext)s');
    });

    it('the returned template is relative, so --paths home: decides the location', () => {
      const templates = [
        buildOutputTemplate({ mode: 'video' }),
        buildOutputTemplate({ mode: 'stream' }),
        buildOutputTemplate({ mode: 'video', isPlaylist: true, folderHint: 'Series' }),
      ];
      for (const template of templates) {
        expect(isAbsolute(template)).toBe(false);
        expect(template.startsWith('/')).toBe(false);
      }
    });
  });

  describe('isConfirmedMultiItem', () => {
    it('a plain single video is not multi-item, so it gets no folder', () => {
      expect(isConfirmedMultiItem({ mode: 'video' })).toBe(false);
      expect(isConfirmedMultiItem({ mode: 'video', titleHint: 'Some video' })).toBe(false);
    });

    it('only a confirmed playlist, item selection or folder name counts', () => {
      expect(isConfirmedMultiItem({ mode: 'video', isPlaylist: true })).toBe(true);
      expect(isConfirmedMultiItem({ mode: 'video', playlistItems: '1-5' })).toBe(true);
      expect(isConfirmedMultiItem({ mode: 'video', folderHint: 'Series' })).toBe(true);
    });

    it('ignores a blank folderHint rather than creating a folder named after nothing', () => {
      expect(isConfirmedMultiItem({ mode: 'video', folderHint: '   ' })).toBe(false);
      expect(isConfirmedMultiItem({ mode: 'video', playlistItems: '' })).toBe(false);
    });

    it('a live stream is never foldered, whatever else is set', () => {
      expect(isConfirmedMultiItem({ mode: 'stream', isPlaylist: true, folderHint: 'X' })).toBe(false);
    });
  });
});

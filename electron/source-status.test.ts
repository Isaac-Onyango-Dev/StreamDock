import { describe, it, expect } from 'vitest';
import { splitReferenceText, classifyHost } from './source-status';

describe('source-status', () => {
  describe('splitReferenceText', () => {
    it('splits around a graveyard marker, case-insensitively', () => {
      const raw = 'Active Sites\nHiAnime\nAnimePahe\nGraveyard\nAnimeKai is moved to Graveyard';
      const { activeText, retiredText } = splitReferenceText(raw);
      expect(activeText).toContain('hianime');
      expect(activeText).not.toContain('graveyard');
      expect(retiredText).toContain('animekai');
    });

    it('treats the whole page as active text when no graveyard section exists', () => {
      const raw = 'Active Sites\nHiAnime\nAnimePahe';
      const { activeText, retiredText } = splitReferenceText(raw);
      expect(activeText).toContain('hianime');
      expect(retiredText).toBe('');
    });
  });

  describe('classifyHost', () => {
    const activeText = 'ranked sites: hianime, animepahe, aniwatch';
    const retiredText = 'graveyard: animekai is moved to graveyard';

    it('classifies a host mentioned only in the active section', () => {
      expect(classifyHost('hianime.to', activeText, retiredText)).toBe('active');
    });

    it('classifies a host mentioned in the retired/graveyard section', () => {
      expect(classifyHost('animekai.to', activeText, retiredText)).toBe('retired');
    });

    it('returns unknown for a host mentioned nowhere', () => {
      expect(classifyHost('some-other-site.com', activeText, retiredText)).toBe('unknown');
    });

    it('is defensive against an empty host', () => {
      expect(classifyHost('', activeText, retiredText)).toBe('unknown');
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildQualityChoices,
  buildQualityValue,
  capFromQualityValue,
  summarizeQualitySpread,
} from './quality';

const labels = (mode: 'video' | 'stream', heights: number[]) =>
  buildQualityChoices(mode, heights).map((choice) => choice.label);

describe('quality choices', () => {
  describe('only what the source actually reported', () => {
    // The defect: with nothing detected the picker fell back to a hardcoded
    // 1080/720/480/360 ladder. That fired before Analyze had run, for every
    // playlist, and for every episode-range probe — so the list a user saw was
    // usually not the source's, and 1080p looked selectable on a 480p source.
    it('offers no resolutions at all when none were detected', () => {
      expect(labels('video', [])).toEqual(['Best quality']);
    });

    it('does not invent 1080p for a source that tops out lower', () => {
      expect(labels('video', [480, 360])).toEqual(['Best quality', 'up to 480p', 'up to 360p']);
      expect(labels('video', [480, 360]).join(' ')).not.toContain('1080');
    });

    it('lists detected heights high to low, without duplicates', () => {
      expect(labels('video', [720, 1080, 720, 480])).toEqual([
        'Best quality', 'up to 1080p', 'up to 720p', 'up to 480p',
      ]);
    });

    it('ignores nonsense heights rather than offering them', () => {
      expect(labels('video', [0, -1, Number.NaN, 720])).toEqual(['Best quality', 'up to 720p']);
    });
  });

  describe('best quality means best available for that item', () => {
    it('is an empty selector, so the engine resolves it per entry', () => {
      expect(buildQualityChoices('video', [1080])[0].value).toBe('');
    });

    // Verified against the engine: one shared selector returned 240p for a
    // 240p-max video and 720p for a 720p-max video in the same run.
    it('resolves each item to its own maximum', () => {
      expect(summarizeQualitySpread([1080, 720, 1080], null)).toEqual([
        { height: 1080, count: 2 },
        { height: 720, count: 1 },
      ]);
    });
  });

  describe('an explicit pick is a ceiling, not a requirement', () => {
    it('builds height<= rather than height=', () => {
      expect(buildQualityValue('video', 1080)).toContain('height<=1080');
      expect(buildQualityValue('video', 1080)).not.toContain('height=1080');
    });

    // The brief's Option A (skip items lacking the quality) is explicitly not
    // what happens, and Option C is: highest available, capped.
    it('downgrades an item instead of skipping it', () => {
      expect(summarizeQualitySpread([1080, 720, 1080], 1080)).toEqual([
        { height: 1080, count: 2 },
        { height: 720, count: 1 },
      ]);
    });

    it('never upscales past what an item has', () => {
      expect(summarizeQualitySpread([480], 1080)).toEqual([{ height: 480, count: 1 }]);
    });

    it('caps every item that exceeds the pick', () => {
      expect(summarizeQualitySpread([1080, 1080, 720], 720)).toEqual([{ height: 720, count: 3 }]);
    });

    it('reads the cap back out of a selector', () => {
      expect(capFromQualityValue(buildQualityValue('video', 720))).toBe(720);
      expect(capFromQualityValue('')).toBeNull();
    });
  });

  describe('the brief\'s worked example', () => {
    it('Ep1 1080/720, Ep2 720/480, Ep3 1080/720 → 1080, 720, 1080', () => {
      const episodes = [
        Math.max(1080, 720),
        Math.max(720, 480),
        Math.max(1080, 720),
      ];
      expect(summarizeQualitySpread(episodes, null)).toEqual([
        { height: 1080, count: 2 },
        { height: 720, count: 1 },
      ]);
    });
  });

  describe('stream mode', () => {
    it('uses a single-stream selector rather than a video+audio pair', () => {
      expect(buildQualityValue('stream', 720)).toBe('best[height<=720]/best');
    });
  });
});

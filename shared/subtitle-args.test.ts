import { describe, expect, it } from 'vitest';
import {
  buildSubtitleArgs,
  resolveSubtitleMode,
  subtitleModeFromSettings,
} from './subtitle-args';

describe('subtitle-args', () => {
  describe('the "None still embeds" regression', () => {
    // The defect: applyYtDlpOptions ran after the per-download picker and
    // appended --embed-subs whenever the global embedSubs setting was true — a
    // setting whose persisted default was true. Choosing "None" therefore still
    // embedded a subtitle track, on a clean install, with no user action.
    //
    // Confirmed against yt-dlp that --embed-subs alone is enough to make it
    // fetch subtitles, so this was never harmless:
    //   --skip-download                → requested_subtitles=NA
    //   --skip-download --embed-subs   → requested_subtitles={'en': {...}}
    it('emits nothing at all for "none"', () => {
      expect(buildSubtitleArgs({ subtitleMode: 'none' })).toEqual([]);
    });

    it('still emits nothing for "none" when languages happen to be selected', () => {
      // A leftover selection in the language modal used to re-enable subtitles
      // behind the user's back, because any selected language counted as a
      // request for them.
      expect(
        buildSubtitleArgs({ subtitleMode: 'none', selectedSubtitleLanguages: ['en', 'ja'] }),
      ).toEqual([]);
    });
  });

  describe('the three behaviours stay distinct', () => {
    it('sidecar writes a file and does not embed', () => {
      const args = buildSubtitleArgs({ subtitleMode: 'sidecar' });
      expect(args).toContain('--write-subs');
      expect(args).not.toContain('--embed-subs');
    });

    it('embed muxes a track and leaves no loose file', () => {
      // --write-subs means "keep the file". Passing it alongside --embed-subs is
      // what left stray .vtt files beside finished downloads.
      const args = buildSubtitleArgs({ subtitleMode: 'embed' });
      expect(args).toContain('--embed-subs');
      expect(args).not.toContain('--write-subs');
    });

    it('both is the only mode that asks for both', () => {
      const args = buildSubtitleArgs({ subtitleMode: 'both' });
      expect(args).toContain('--write-subs');
      expect(args).toContain('--embed-subs');
    });

    it('never burns subtitles into the picture', () => {
      // Burned-in subtitles are destructive and deliberately unimplemented.
      for (const mode of ['none', 'sidecar', 'embed', 'both'] as const) {
        const joined = buildSubtitleArgs({ subtitleMode: mode }).join(' ');
        expect(joined).not.toContain('subtitles=');
        expect(joined).not.toContain('-vf');
      }
    });
  });

  describe('languages and conversion', () => {
    it('defaults to plain en, never the en.* wildcard', () => {
      // 'en.*' also matches YouTube's machine translations (en-en, en-de, …),
      // turning one subtitle fetch into a burst big enough to earn a 429 that
      // aborts the whole video download.
      const args = buildSubtitleArgs({ subtitleMode: 'embed' });
      expect(args[args.indexOf('--sub-langs') + 1]).toBe('en');
    });

    it('passes every selected language through', () => {
      const args = buildSubtitleArgs({
        subtitleMode: 'sidecar',
        selectedSubtitleLanguages: ['en', 'ja', 'es'],
      });
      expect(args[args.indexOf('--sub-langs') + 1]).toBe('en,ja,es');
    });

    it('converts only when asked', () => {
      expect(buildSubtitleArgs({ subtitleMode: 'sidecar', subtitleConvertFormat: 'srt' }))
        .toContain('srt');
      expect(buildSubtitleArgs({ subtitleMode: 'sidecar', subtitleConvertFormat: 'original' }))
        .not.toContain('--convert-subs');
    });
  });

  describe('resolveSubtitleMode', () => {
    it('lets "subtitles only" outrank the picker, since there is no video to embed into', () => {
      expect(resolveSubtitleMode({ subsOnly: true, subtitleMode: 'embed' })).toBe('sidecar');
      expect(resolveSubtitleMode({ downloadPackaging: 'subs-only', subtitleMode: 'none' })).toBe('sidecar');
    });

    it('otherwise the per-download picker wins outright', () => {
      expect(resolveSubtitleMode({ subtitleMode: 'none', downloadPackaging: 'video-subs' })).toBe('none');
      expect(resolveSubtitleMode({ subtitleMode: 'both' })).toBe('both');
    });

    it('falls back to embed when nothing was chosen', () => {
      expect(resolveSubtitleMode({})).toBe('embed');
    });
  });

  describe('settings migration', () => {
    it('turns the old off switch into "none" rather than silently re-enabling subtitles', () => {
      expect(subtitleModeFromSettings({ embedSubs: false })).toBe('none');
    });

    it('keeps existing behaviour for everyone else', () => {
      expect(subtitleModeFromSettings({ embedSubs: true })).toBe('embed');
      expect(subtitleModeFromSettings(undefined)).toBe('embed');
      expect(subtitleModeFromSettings({})).toBe('embed');
    });

    it('prefers an explicit mode over the legacy boolean', () => {
      expect(subtitleModeFromSettings({ subtitleMode: 'sidecar', embedSubs: true })).toBe('sidecar');
    });
  });
});

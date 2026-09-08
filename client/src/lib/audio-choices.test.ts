import { describe, expect, it } from 'vitest';
import { buildAudioChoices, hasLanguageStreams } from './audio-choices';
import type { AudioTrack } from './types';

function track(language: string, id = language): AudioTrack {
  return { id, language, label: language, isDefault: false, isOriginal: false, isDub: false };
}

/**
 * The Audio control offered "English dub" and "Original" unconditionally —
 * before Analyze had run, and for every source. It is implemented with
 * `--format-sort lang:…`, which reorders audio renditions inside one manifest,
 * so with fewer than two detected audio languages it cannot take effect at all.
 *
 * On anikoto it can never take effect: sub and dub are separate manifest URLs,
 * not audio tracks. The choice that worked was the detected stream options,
 * which sat behind a button while this one was shown by default.
 */
describe('buildAudioChoices', () => {
  it('offers only Auto before anything has been detected', () => {
    expect(buildAudioChoices(undefined).map((c) => c.value)).toEqual(['auto']);
    expect(buildAudioChoices([]).map((c) => c.value)).toEqual(['auto']);
  });

  it('offers only Auto when the source has a single audio language', () => {
    expect(buildAudioChoices([track('ja')]).map((c) => c.value)).toEqual(['auto']);
    expect(buildAudioChoices([track('ja', 'a'), track('ja', 'b')]).map((c) => c.value)).toEqual(['auto']);
  });

  it('offers a preference once there are two languages to sort between', () => {
    expect(buildAudioChoices([track('ja'), track('en')]).map((c) => c.value)).toEqual([
      'auto',
      'dub',
      'sub',
    ]);
  });

  it('ignores undeclared languages, which cannot be sorted on', () => {
    expect(buildAudioChoices([track('und'), track(''), track('ja')]).map((c) => c.value)).toEqual([
      'auto',
    ]);
  });

  it('never invents a language ladder the way the old list did', () => {
    const labels = buildAudioChoices([track('ja'), track('en')]).map((c) => c.label);
    expect(labels).not.toContain('English dub');
    expect(labels.every((label) => label.length > 0)).toBe(true);
  });
});

describe('hasLanguageStreams', () => {
  it('needs more than one stream to be a choice', () => {
    expect(hasLanguageStreams(undefined)).toBe(false);
    expect(hasLanguageStreams(0)).toBe(false);
    expect(hasLanguageStreams(1)).toBe(false);
    expect(hasLanguageStreams(2)).toBe(true);
  });
});

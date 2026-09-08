import { describe, expect, it } from 'vitest';
import {
  classifyDeclaredLanguage,
  classifyDeclaredTranslation,
  classifyLanguageHints,
  languageName,
  normalizeLanguageCode,
} from './language';

/**
 * The probe's old classifier tested bare substrings over whole URLs:
 *
 *   if (lower.includes('dub') && lower.includes('en')) return 'English Dub';
 *   ...
 *   if (lower.includes('hub')) return 'Hub';
 *
 * Two defects fall out of that. "en" appears inside generic, screen, engine and
 * segment, so almost any CDN path classified as English; and "hub" was treated
 * as a language of its own, which matches animehub, github and cdn-hub. Both
 * answers were then shown in the same badge as a language the manifest had
 * actually declared.
 */
describe('classifyLanguageHints', () => {
  it('does not read "en" out of unrelated words', () => {
    for (const url of [
      'https://cdn.example.com/generic/stream.m3u8',
      'https://cdn.example.com/segment-00012.ts',
      'https://cdn.example.com/fullscreen/player.m3u8',
      'https://engine.example.com/playlist.m3u8',
    ]) {
      const result = classifyLanguageHints(url);
      expect(result.languageCode).toBe('und');
      expect(result.confidence).toBe('unknown');
    }
  });

  it('does not treat "hub" as a language', () => {
    for (const url of [
      'https://123animehub.cc/stream/master.m3u8',
      'https://github.com/example/file.m3u8',
      'https://cdn-hub.example.com/master.m3u8',
    ]) {
      expect(classifyLanguageHints(url).label).toBe('Unknown');
    }
  });

  it('marks anything read out of a URL as inferred, never declared', () => {
    const result = classifyLanguageHints('https://cdn.example.com/english-dub/master.m3u8');
    expect(result.confidence).toBe('inferred');
    expect(result.translation).toBe('dub');
    expect(result.languageCode).toBe('en');
    expect(result.label).toBe('English Dub');
  });

  it('separates translation type from spoken language', () => {
    // A dub whose language is not stated is still known to be a dub.
    const dubOnly = classifyLanguageHints('server-2-dub');
    expect(dubOnly.translation).toBe('dub');
    expect(dubOnly.languageCode).toBe('und');
    expect(dubOnly.label).toBe('Dub');

    // A language with no dub/sub marker is still known to be that language.
    const langOnly = classifyLanguageHints('audio-spanish');
    expect(langOnly.translation).toBe('unknown');
    expect(langOnly.languageCode).toBe('es');
    expect(langOnly.label).toBe('Spanish');
  });

  it('recognises raw as its own state, not as sub', () => {
    const raw = classifyLanguageHints('https://cdn.example.com/raw/master.m3u8');
    expect(raw.translation).toBe('raw');
    expect(raw.label).toBe('Raw');
  });

  it('reports unknown rather than inventing a label', () => {
    const result = classifyLanguageHints(undefined, null, '', 'https://cdn.example.com/x/y.m3u8');
    expect(result.translation).toBe('unknown');
    expect(result.languageCode).toBe('und');
    expect(result.confidence).toBe('unknown');
    expect(result.label).toBe('Unknown');
  });

  it('uses the first source that carries a usable signal', () => {
    const result = classifyLanguageHints('https://cdn.example.com/seg.ts', 'japanese-sub');
    expect(result.languageCode).toBe('ja');
    expect(result.translation).toBe('sub');
  });
});

describe('classifyDeclaredLanguage', () => {
  it('marks a manifest-declared language as declared', () => {
    const result = classifyDeclaredLanguage('en', 'English');
    expect(result.confidence).toBe('declared');
    expect(result.languageCode).toBe('en');
  });

  it('keeps the track name the source supplied as the label', () => {
    expect(classifyDeclaredLanguage('es', 'Español (Latino)').label).toBe('Español (Latino)');
  });

  it('picks the dub marker out of a declared track name', () => {
    expect(classifyDeclaredLanguage('en', 'English Dub').translation).toBe('dub');
  });

  it('reports unknown when the source declared nothing usable', () => {
    const result = classifyDeclaredLanguage(undefined, undefined);
    expect(result.confidence).toBe('unknown');
    expect(result.label).toBe('Unknown');
  });
});

describe('normalizeLanguageCode', () => {
  it('reduces regional and three-letter codes to a base code', () => {
    expect(normalizeLanguageCode('en-US')).toBe('en');
    expect(normalizeLanguageCode('jpn')).toBe('ja');
    expect(normalizeLanguageCode('pt_BR')).toBe('pt');
  });

  it('returns und for missing or meaningless input', () => {
    expect(normalizeLanguageCode(undefined)).toBe('und');
    expect(normalizeLanguageCode('')).toBe('und');
    expect(normalizeLanguageCode('und')).toBe('und');
  });
});

describe('languageName', () => {
  it('names known codes and says Unknown for und', () => {
    expect(languageName('ja')).toBe('Japanese');
    expect(languageName('und')).toBe('Unknown');
  });
});

/**
 * anikoto marks its server lists `data-type="sub"` / `data-type="dub"`, so the
 * tri-state arrives as provider data. Measured against the live page: the
 * declared pass yields exactly two options where the previous selectors
 * produced five, three of which were not languages at all.
 */
describe('classifyDeclaredTranslation', () => {
  it('treats a stated sub/dub/raw as declared, not guessed', () => {
    for (const [value, translation, label] of [
      ['sub', 'sub', 'Sub'],
      ['dub', 'dub', 'Dub'],
      ['raw', 'raw', 'Raw'],
    ] as const) {
      const result = classifyDeclaredTranslation(value);
      expect(result.translation).toBe(translation);
      expect(result.label).toBe(label);
      expect(result.confidence).toBe('declared');
    }
  });

  it('leaves the spoken language unknown — "dub" says dubbed, not into what', () => {
    expect(classifyDeclaredTranslation('dub').languageCode).toBe('und');
  });

  it('reports unknown for anything it was not given', () => {
    for (const value of [undefined, null, '', 'Vidstream-2', '720p']) {
      const result = classifyDeclaredTranslation(value);
      expect(result.confidence).toBe('unknown');
      expect(result.label).toBe('Unknown');
    }
  });
});

/**
 * One answer to "what language is this stream, and how do we know?".
 *
 * StreamDock had two classifiers that answered the same question differently.
 * `manifest-parser.ts` read real `#EXT-X-MEDIA:LANGUAGE` attributes; the probe
 * in `stream-options-probe.ts` substring-matched URLs and DOM text and *always*
 * returned something, so a guess drawn from a CDN path was presented to the
 * user exactly like a language the manifest actually declared. When two code
 * paths answer the same question, the last one wins and nobody can tell which
 * answer they got.
 *
 * The shape here is borrowed (as a design, not as code) from how the anime CLIs
 * surveyed in session 14 model this: translation type is tri-state and
 * independent of the spoken language, and it is carried as provider data rather
 * than re-derived from a URL at each use site. The addition StreamDock needs on
 * top is `confidence` — a guess must stay visibly a guess.
 */

/**
 * Whether the audio is dubbed, the original with subtitles, or untranslated.
 * Deliberately separate from `languageCode`: "English Dub" is two facts, and a
 * source often declares one without the other.
 */
export type TranslationType = 'sub' | 'dub' | 'raw' | 'unknown';

/**
 * Where the classification came from.
 *
 * - `declared` — the source stated it (an HLS `LANGUAGE` attribute, a DASH
 *   `lang`, an API field). Trustworthy.
 * - `inferred` — read out of a URL, filename or button label. A hint, and the
 *   UI must not present it as fact.
 * - `unknown` — nothing usable was found.
 */
export type LanguageConfidence = 'declared' | 'inferred' | 'unknown';

export interface LanguageClassification {
  translation: TranslationType;
  /** BCP-47-ish base code, or `und` when no language could be determined. */
  languageCode: string;
  /** Display string, e.g. "English Dub", "Japanese", "Dub", "Unknown". */
  label: string;
  confidence: LanguageConfidence;
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ja: 'Japanese',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  it: 'Italian',
  ar: 'Arabic',
  ko: 'Korean',
  zh: 'Chinese',
  ru: 'Russian',
  hi: 'Hindi',
  tr: 'Turkish',
  th: 'Thai',
  vi: 'Vietnamese',
  id: 'Indonesian',
  pl: 'Polish',
};

/**
 * Tokens that identify a language when found in free text.
 *
 * Matched on word boundaries. The previous implementation tested
 * `lower.includes('en')`, which is true of "generic", "screen" and "engine" —
 * so almost any CDN path classified as English.
 */
const LANGUAGE_TOKENS: Array<[RegExp, string]> = [
  [/\b(?:en|eng|english)\b/, 'en'],
  [/\b(?:ja|jp|jpn|japanese)\b/, 'ja'],
  [/\b(?:es|spa|spanish|castellano|latino)\b/, 'es'],
  [/\b(?:fr|fra|fre|french)\b/, 'fr'],
  [/\b(?:de|deu|ger|german)\b/, 'de'],
  [/\b(?:pt|por|portuguese)\b/, 'pt'],
  [/\b(?:it|ita|italian)\b/, 'it'],
  [/\b(?:ar|ara|arabic)\b/, 'ar'],
  [/\b(?:ko|kor|korean)\b/, 'ko'],
  [/\b(?:zh|chi|zho|chinese|mandarin)\b/, 'zh'],
  [/\b(?:ru|rus|russian)\b/, 'ru'],
  [/\b(?:hi|hin|hindi)\b/, 'hi'],
  [/\b(?:tr|tur|turkish)\b/, 'tr'],
  [/\b(?:th|tha|thai)\b/, 'th'],
  [/\b(?:vi|vie|vietnamese)\b/, 'vi'],
  [/\b(?:id|ind|indonesian)\b/, 'id'],
  [/\b(?:pl|pol|polish)\b/, 'pl'],
];

/** Split on the separators that appear in URLs, ids and button labels. */
function tokenize(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function normalizeLanguageCode(raw: string | undefined | null): string {
  if (!raw) return 'und';
  const cleaned = raw.trim().toLowerCase().replace(/_/g, '-');
  if (!cleaned || cleaned === 'und' || cleaned === 'undefined') return 'und';
  const base = cleaned.split('-')[0];
  if (!base) return 'und';
  // Accept a 3-letter code by mapping it through the token table, so 'jpn'
  // and 'ja' land on the same entry.
  if (LANGUAGE_NAMES[base]) return base;
  const spaced = ` ${base} `;
  for (const [pattern, code] of LANGUAGE_TOKENS) {
    if (pattern.test(spaced)) return code;
  }
  return base;
}

export function languageName(code: string): string {
  const normalized = normalizeLanguageCode(code);
  if (normalized === 'und') return 'Unknown';
  return LANGUAGE_NAMES[normalized] || normalized.toUpperCase();
}

export function describeTranslation(translation: TranslationType): string {
  switch (translation) {
    case 'dub':
      return 'Dub';
    case 'sub':
      return 'Sub';
    case 'raw':
      return 'Raw';
    default:
      return '';
  }
}

function buildLabel(languageCode: string, translation: TranslationType): string {
  const name = languageCode === 'und' ? '' : languageName(languageCode);
  const type = describeTranslation(translation);
  if (name && type) return `${name} ${type}`;
  if (name) return name;
  if (type) return type;
  return 'Unknown';
}

function detectTranslation(text: string): TranslationType {
  // `raw` is checked first: a "raw" listing is untranslated even when the page
  // also carries the word "sub" elsewhere in the same string.
  if (/\braw\b/.test(text)) return 'raw';
  if (/\bdub(?:bed|s)?\b/.test(text)) return 'dub';
  if (/\bsub(?:bed|s|title[ds]?)?\b/.test(text)) return 'sub';
  return 'unknown';
}

function detectLanguage(text: string): string {
  const spaced = ` ${text} `;
  for (const [pattern, code] of LANGUAGE_TOKENS) {
    if (pattern.test(spaced)) return code;
  }
  return 'und';
}

/**
 * Classify a language the source actually declared — an HLS `LANGUAGE`
 * attribute, a DASH `lang`, or an API field.
 *
 * `name` is the human-readable track name that usually accompanies it, and is
 * the only place a dub/sub distinction normally appears, since the language
 * attribute itself only carries the spoken language.
 */
export function classifyDeclaredLanguage(
  code: string | undefined | null,
  name?: string | null,
): LanguageClassification {
  const languageCode = normalizeLanguageCode(code);
  const translation = detectTranslation(tokenize(name || ''));

  if (languageCode === 'und' && translation === 'unknown') {
    return { translation: 'unknown', languageCode: 'und', label: 'Unknown', confidence: 'unknown' };
  }

  return {
    translation,
    languageCode,
    // A declared track's own name is the better label when it has one.
    label: name?.trim() || buildLabel(languageCode, translation),
    confidence: 'declared',
  };
}

/**
 * Best-effort classification from free text — a manifest URL, a format id, a
 * button caption.
 *
 * Returns `confidence: 'unknown'` when nothing matched, instead of inventing a
 * label. The old behaviour returned `'Unknown'` as though it were a detected
 * language, and separately treated a bare "hub" as a language of its own,
 * which matched hostnames like `animehub` and every `github` URL.
 */
export function classifyLanguageHints(
  ...sources: Array<string | undefined | null>
): LanguageClassification {
  for (const raw of sources) {
    if (!raw) continue;
    const text = tokenize(raw);
    if (!text) continue;

    const translation = detectTranslation(text);
    const languageCode = detectLanguage(text);
    if (translation === 'unknown' && languageCode === 'und') continue;

    return {
      translation,
      languageCode,
      label: buildLabel(languageCode, translation),
      confidence: 'inferred',
    };
  }

  return { translation: 'unknown', languageCode: 'und', label: 'Unknown', confidence: 'unknown' };
}

/**
 * Classify a translation type the site itself states — e.g. anikoto marks its
 * server lists `data-type="sub"` / `data-type="dub"`.
 *
 * This is the tri-state arriving as provider data rather than being guessed
 * out of a URL, which is the whole point of separating the two. The spoken
 * language stays `und`: "dub" says the audio is dubbed, not into what.
 */
export function classifyDeclaredTranslation(
  raw: string | undefined | null,
): LanguageClassification {
  const value = (raw || '').trim().toLowerCase();
  const translation: TranslationType =
    value === 'dub' ? 'dub' : value === 'sub' ? 'sub' : value === 'raw' ? 'raw' : 'unknown';

  if (translation === 'unknown') {
    return { translation, languageCode: 'und', label: 'Unknown', confidence: 'unknown' };
  }

  return {
    translation,
    languageCode: 'und',
    label: describeTranslation(translation),
    confidence: 'declared',
  };
}

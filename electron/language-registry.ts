// Role: normalize BCP-47 / ISO language codes into display labels and flags.

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  'en-us': 'English (US)',
  'en-gb': 'English (UK)',
  'en-au': 'English (Australia)',
  ja: 'Japanese',
  jpn: 'Japanese',
  es: 'Spanish',
  'es-la': 'Spanish (Latin America)',
  'es-419': 'Spanish (Latin America)',
  'es-es': 'Spanish (Spain)',
  fr: 'French',
  'fr-fr': 'French (France)',
  'fr-ca': 'French (Canada)',
  de: 'German',
  pt: 'Portuguese',
  'pt-br': 'Portuguese (Brazil)',
  'pt-pt': 'Portuguese (Portugal)',
  ar: 'Arabic',
  hi: 'Hindi',
  ko: 'Korean',
  zh: 'Chinese',
  'zh-cn': 'Chinese (Simplified)',
  'zh-tw': 'Chinese (Traditional)',
  'zh-hans': 'Chinese (Simplified)',
  'zh-hant': 'Chinese (Traditional)',
  it: 'Italian',
  ru: 'Russian',
  id: 'Indonesian',
  ms: 'Malay',
  th: 'Thai',
  vi: 'Vietnamese',
  tr: 'Turkish',
  nl: 'Dutch',
  pl: 'Polish',
  und: 'Unknown',
};

const ORIGINAL_LANGUAGE_HINTS = new Set(['ja', 'jpn', 'jp', 'japanese', 'original', 'native']);

export function normalizeLanguageCode(raw: string | undefined | null): string {
  if (!raw) return 'und';
  const cleaned = raw.trim().toLowerCase().replace(/_/g, '-');
  if (!cleaned) return 'und';
  if (LANGUAGE_NAMES[cleaned]) return cleaned;
  const base = cleaned.split('-')[0];
  return base || 'und';
}

export function getLanguageName(code: string, fallbackName?: string): string {
  const normalized = normalizeLanguageCode(code);
  if (fallbackName?.trim()) {
    const lower = fallbackName.toLowerCase();
    if (lower.includes('dub')) return `${getLanguageName(normalized)} Dub`;
    if (lower.includes('original')) return `${getLanguageName(normalized)} (Original)`;
    return fallbackName.trim();
  }
  return LANGUAGE_NAMES[normalized] || LANGUAGE_NAMES[normalizeLanguageCode(normalized)] || code.toUpperCase();
}

export function isOriginalLanguageHint(code: string, name?: string): boolean {
  const normalized = normalizeLanguageCode(code);
  if (ORIGINAL_LANGUAGE_HINTS.has(normalized)) return true;
  const label = `${name || ''} ${code}`.toLowerCase();
  return /original|japanese|native|ja\b/.test(label);
}

export function isDubLanguageHint(name?: string): boolean {
  if (!name) return false;
  return /\bdub\b/i.test(name);
}

export function dedupeKeyForLanguage(code: string, name?: string, groupId?: string): string {
  return `${normalizeLanguageCode(code)}::${(name || '').toLowerCase()}::${groupId || ''}`;
}

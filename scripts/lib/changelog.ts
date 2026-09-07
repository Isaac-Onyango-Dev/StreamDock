// Role: single source of truth for "what version are we on, and what shipped in it".
//
// Both the install site and the README render this. They used to disagree
// because only the site was ever generated: the README's "What's New" section
// was hand-maintained, so it sat at v1.0.1 while the app shipped 1.2.0.
import { readFileSync } from 'fs';
import { join } from 'path';

export const repoRoot = join(import.meta.dirname, '..', '..');

export function readProjectFile(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf-8');
}

/**
 * The version being published.
 *
 * `RELEASE_TAG` wins when set so a release build renders the tag it is
 * actually publishing, rather than whatever package.json happened to hold.
 */
export function resolveVersion(): string {
  const fromTag = process.env.RELEASE_TAG;
  if (fromTag) return fromTag.replace(/^v/i, '');
  const pkg = JSON.parse(readProjectFile('package.json')) as { version: string };
  return pkg.version;
}

export interface ChangelogSection {
  /** "Added", "Fixed", … */
  title: string;
  items: string[];
}

export interface ChangelogEntry {
  version: string;
  date: string;
  /** Raw lines between this heading and the next, for consumers that want them. */
  body: string[];
  sections: ChangelogSection[];
}

export function parseChangelog(markdown: string): ChangelogEntry[] {
  const lines = markdown.split(/\r?\n/);
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  let section: ChangelogSection | null = null;

  const closeSection = () => {
    if (current && section && section.items.length > 0) current.sections.push(section);
    section = null;
  };

  for (const line of lines) {
    const heading = line.match(/^##\s+\[([^\]]+)\]\s*-\s*(.+)$/);
    if (heading) {
      closeSection();
      if (current) entries.push(current);
      current = { version: heading[1], date: heading[2].trim(), body: [], sections: [] };
      continue;
    }
    if (!current) continue;

    current.body.push(line);

    const subheading = line.match(/^###\s+(.*)$/);
    if (subheading) {
      closeSection();
      section = { title: subheading[1].trim(), items: [] };
      continue;
    }

    const bullet = line.match(/^-\s+(.*)$/);
    if (bullet) {
      // Bullets before any "### Section" still belong to the entry.
      if (!section) section = { title: '', items: [] };
      section.items.push(bullet[1].trim());
      continue;
    }

    // Continuation lines of a wrapped bullet.
    const continuation = line.match(/^\s{2,}(\S.*)$/);
    if (continuation && section && section.items.length > 0) {
      section.items[section.items.length - 1] += ` ${continuation[1].trim()}`;
    }
  }

  closeSection();
  if (current) entries.push(current);
  return entries;
}

/** The changelog entry for `version`, falling back to the newest entry. */
export function entryForVersion(entries: ChangelogEntry[], version: string): ChangelogEntry | null {
  return entries.find((entry) => entry.version === version) ?? entries[0] ?? null;
}

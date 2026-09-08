// Role: emit the release body for the version currently in package.json.
//
// The GitHub release gets two things stitched together: this file's hand-written
// CHANGELOG section (which carries the *why* — root causes, not just subjects)
// followed by GitHub's own auto-generated commit/PR list. Neither alone is
// enough: generated notes read as a list of commit subjects, and a hand-written
// section alone loses the contributor/PR attribution.
//
// Usage: tsx scripts/release-notes.ts [version] > notes.md
import { parseChangelog, readProjectFile, resolveVersion } from './lib/changelog';

const version = process.argv[2]?.replace(/^v/i, '') || resolveVersion();
const entries = parseChangelog(readProjectFile('CHANGELOG.md'));
// Deliberately an exact match rather than `entryForVersion`, which falls back to
// the newest entry: for release notes that would silently attach the *previous*
// version's notes to this release. A missing entry must produce the stub below.
const entry = entries.find((candidate) => candidate.version === version);

if (!entry) {
  // Not fatal: a release must still go out even if someone forgot the entry.
  // The auto-generated notes GitHub appends will carry the commit list.
  process.stderr.write(`[release-notes] No CHANGELOG entry for ${version}; emitting a stub.\n`);
  process.stdout.write(`## StreamDock v${version}\n\nSee the commit list below.\n`);
  process.exit(0);
}

const body = entry.body
  .join('\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

process.stdout.write(`## What's in v${version}\n\n${body}\n`);

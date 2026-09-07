import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '..');
const docsDir = join(root, 'docs');

function readProjectFile(path: string): string {
  return readFileSync(join(root, path), 'utf-8');
}

function resolveVersion(): string {
  const fromTag = process.env.RELEASE_TAG;
  if (fromTag) return fromTag.replace(/^v/i, '');
  const pkg = JSON.parse(readProjectFile('package.json')) as { version: string };
  return pkg.version;
}

interface ChangelogEntry {
  version: string;
  date: string;
  body: string[]; // raw lines between the heading and the next heading
}

function parseChangelog(markdown: string): ChangelogEntry[] {
  const lines = markdown.split(/\r?\n/);
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;

  for (const line of lines) {
    const heading = line.match(/^##\s+\[([^\]]+)\]\s*-\s*(.+)$/);
    if (heading) {
      if (current) entries.push(current);
      current = { version: heading[1], date: heading[2].trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) entries.push(current);
  return entries;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inlineMarkdown(text: string): string {
  // Minimal inline support: `code` and **bold**, applied after HTML-escaping.
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function renderEntry(entry: ChangelogEntry): string {
  const items: string[] = [];
  let title = '';

  for (const line of entry.body) {
    const bullet = line.match(/^-\s+(.*)$/);
    if (bullet) {
      items.push(bullet[1]);
      continue;
    }
    const heading = line.match(/^###\s+(.*)$/);
    if (heading && !title) {
      title = heading[1].trim();
    }
  }

  const listHtml = items.length
    ? `<ul>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</ul>`
    : '';

  return `    <div class="release">
      <div class="release-head">
        <span class="version-tag">v${escapeHtml(entry.version)}</span>
        <span class="release-date">${escapeHtml(entry.date)}</span>
      </div>
      ${title ? `<h3>${escapeHtml(title)}</h3>` : ''}
      ${listHtml}
    </div>`;
}

function buildChangelogHtml(maxEntries = 3): string {
  const markdown = readProjectFile('CHANGELOG.md');
  const entries = parseChangelog(markdown).slice(0, maxEntries);
  return entries.map(renderEntry).join('\n');
}

function main(): void {
  const version = resolveVersion();
  const changelogHtml = buildChangelogHtml();

  const template = readFileSync(join(docsDir, 'index.template.html'), 'utf-8');
  const rendered = template
    .split('{{VERSION}}').join(version)
    .split('{{CHANGELOG_HTML}}').join(changelogHtml);

  writeFileSync(join(docsDir, 'index.html'), rendered, 'utf-8');
  console.log(`Built docs/index.html for v${version} (${changelogHtml ? 'changelog injected' : 'no changelog entries found'})`);
}

main();

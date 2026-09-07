import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseChangelog, readProjectFile, repoRoot, resolveVersion, type ChangelogEntry } from './lib/changelog';

const docsDir = join(repoRoot, 'docs');

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

interface BrandTokens {
  colors: {
    violet: string;
    violetBright: string;
    pink: string;
    pinkBright: string;
    amber: string;
    amberBright: string;
  };
}

function readBrandTokens(): BrandTokens {
  return JSON.parse(readProjectFile('design/tokens.json')) as BrandTokens;
}

function main(): void {
  const version = resolveVersion();
  const changelogHtml = buildChangelogHtml();
  const { colors } = readBrandTokens();

  const template = readFileSync(join(docsDir, 'index.template.html'), 'utf-8');
  const rendered = template
    .split('{{VERSION}}').join(version)
    .split('{{CHANGELOG_HTML}}').join(changelogHtml)
    .split('{{BRAND_VIOLET}}').join(colors.violet)
    .split('{{BRAND_VIOLET_BRIGHT}}').join(colors.violetBright)
    .split('{{BRAND_PINK}}').join(colors.pink)
    .split('{{BRAND_PINK_BRIGHT}}').join(colors.pinkBright)
    .split('{{BRAND_AMBER}}').join(colors.amber)
    .split('{{BRAND_AMBER_BRIGHT}}').join(colors.amberBright);

  writeFileSync(join(docsDir, 'index.html'), rendered, 'utf-8');
  console.log(`Built docs/index.html for v${version} (${changelogHtml ? 'changelog injected' : 'no changelog entries found'})`);
}

main();

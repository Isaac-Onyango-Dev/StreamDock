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

/**
 * Renders one release from the shared parser's `sections`, never from the raw
 * `body` lines.
 *
 * This used to re-parse `entry.body` with its own `/^-\s+(.*)$/` bullet match,
 * which took the first physical line of each bullet and silently dropped the
 * indented continuation lines beneath it. Changelog bullets in this repo are
 * hard-wrapped prose, so nearly every one of them was published to the site cut
 * off mid-sentence ("…reported as a login wall. Both are").
 *
 * `parseChangelog` already joins those continuations, and sync-readme.ts was
 * already using that — the site had a second, worse copy of the same logic that
 * drifted from it. There is now one parser and one consumer of it.
 *
 * Rendering sections rather than a flat list also fixes a second symptom of the
 * same cause: only the *first* `###` heading was kept, so a release with both
 * "Fixed" and "Changed" showed every bullet under "Fixed".
 */
function renderEntry(entry: ChangelogEntry): string {
  const sectionsHtml = entry.sections
    .filter((section) => section.items.length > 0)
    .map((section) => {
      const heading = section.title ? `<h3>${escapeHtml(section.title)}</h3>` : '';
      const list = `<ul>${section.items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</ul>`;
      return `${heading}${list}`;
    })
    .join('\n      ');

  return `    <div class="release">
      <div class="release-head">
        <span class="version-tag">v${escapeHtml(entry.version)}</span>
        <span class="release-date">${escapeHtml(entry.date)}</span>
      </div>
      ${sectionsHtml}
    </div>`;
}

/**
 * Inlines a platform icon from `docs/assets/icons/` into the page.
 *
 * The icons are the real Font Awesome Free brand marks, kept in the repo as
 * `.svg` files so there is no dependency on a CDN or an icon kit. They are
 * inlined rather than referenced with `<img src>` because both places they
 * appear inherit their colour: the hero pills change colour on hover and when
 * the visitor's OS is detected, and the download cards tint theirs violet. An
 * `<img>` cannot inherit `currentColor`, so referencing the files externally
 * would have cost the theming.
 *
 * Inlining from the file at build time keeps one source of truth: swapping an
 * icon means replacing the .svg, not hand-editing path data in the template.
 */
function buildIconSvg(name: string, size: number): string {
  const raw = readProjectFile(join('docs', 'assets', 'icons', `${name}.svg`));

  const viewBox = raw.match(/viewBox="([^"]+)"/)?.[1];
  if (!viewBox) throw new Error(`Icon ${name}.svg has no viewBox`);

  // Everything between the opening <svg> and its close, minus the license
  // comment — attribution is carried once in the page head instead of repeated
  // on every one of the six icon instances.
  const inner = raw
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>[\s\S]*$/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  if (!inner.includes('<path')) throw new Error(`Icon ${name}.svg has no path data`);

  return (
    `<svg viewBox="${viewBox}" width="${size}" height="${size}" ` +
    `fill="currentColor" aria-hidden="true" focusable="false">${inner}</svg>`
  );
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
    .split('{{BRAND_AMBER_BRIGHT}}').join(colors.amberBright)
    // Three sizes: 14px hero pills, 24px requirements grid, 26px download cards.
    .split('{{ICON_WINDOWS_SM}}').join(buildIconSvg('windows', 14))
    .split('{{ICON_APPLE_SM}}').join(buildIconSvg('apple', 14))
    .split('{{ICON_LINUX_SM}}').join(buildIconSvg('linux', 14))
    .split('{{ICON_WINDOWS_MD}}').join(buildIconSvg('windows', 24))
    .split('{{ICON_APPLE_MD}}').join(buildIconSvg('apple', 24))
    .split('{{ICON_LINUX_MD}}').join(buildIconSvg('linux', 24))
    .split('{{ICON_WINDOWS_LG}}').join(buildIconSvg('windows', 26))
    .split('{{ICON_APPLE_LG}}').join(buildIconSvg('apple', 26))
    .split('{{ICON_LINUX_LG}}').join(buildIconSvg('linux', 26));

  writeFileSync(join(docsDir, 'index.html'), rendered, 'utf-8');
  console.log(`Built docs/index.html for v${version} (${changelogHtml ? 'changelog injected' : 'no changelog entries found'})`);
}

main();

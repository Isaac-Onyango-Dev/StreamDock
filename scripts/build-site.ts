import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseChangelog, readProjectFile, repoRoot, resolveVersion, type ChangelogEntry } from './lib/changelog';
import { readShots, SCREENSHOT_DIR, SCREENSHOT_WIDTHS, type ShotEntry } from './lib/screenshots';

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

/**
 * Widths the browser is told the centre slide will occupy, mirroring the
 * carousel's `--shot-w-max` at each of its two tiers.
 *
 * Written out as plain media conditions rather than the stylesheet's own
 * `min()` calls: `sizes` is parsed before any layout exists, so each `min()`
 * has to be spelled out as the width at which it changes hands.
 *
 *  - under 45rem  : min(82vw, 34rem) — 82vw until it reaches 544px at 663px
 *  - 45rem–60rem  : min(74vw, 40rem) — 74vw until it reaches 640px at 865px
 *  - 60rem and up : min(58vw, 32vw + 14.8rem, 60rem) — the middle term binds
 *                   throughout, until it reaches the 960px cap at 2259px
 *
 * This is an upper bound: on a short window the slide is smaller than the
 * figure here, because the stage shrinks to fit the screen. Overstating it
 * costs a larger candidate; understating it would ship a blurry one.
 */
const SCREENSHOT_SIZES = [
  '(max-width: 663px) 82vw',
  '(max-width: 719px) 544px',
  '(max-width: 864px) 74vw',
  '(max-width: 959px) 640px',
  '(max-width: 2259px) calc(32vw + 237px)',
  '960px',
].join(', ');

/** Native pixel size of every generated asset; see optimize-screenshots.ts. */
const SCREENSHOT_ASPECT = { width: 1600, height: 1034 };

function screenshotSrcset(shot: ShotEntry): string {
  return SCREENSHOT_WIDTHS.map((w) => `${SCREENSHOT_DIR}/${shot.id}-${w}.webp ${w}w`).join(', ');
}

/**
 * Generates the carousel's repeated markup — one slide, one caption and one
 * progress segment per entry in docs/screenshots.json, in that order.
 *
 * The carousel script reads its slide count and its captions out of the DOM and
 * names no image, so a new screenshot is a JSON entry and a re-run of
 * `screenshots:build`; nothing in the template or the script changes.
 */
function buildScreenshotsHtml(): { slides: string; captions: string; steps: string } {
  const shots = readShots();
  const widest = SCREENSHOT_WIDTHS[SCREENSHOT_WIDTHS.length - 1];

  /**
   * The position attribute each slide starts on, with slide 0 active — the
   * same ring arithmetic the carousel script runs, so the served HTML already
   * equals the state JS renders on load.
   *
   * Shipping every slide parked off-stage instead would have been simpler and
   * wrong: the transform transition would then fire on first paint and the
   * left-hand slides would visibly fly in across the centre from the right.
   */
  const startPos = (i: number): string => {
    const d = i > shots.length / 2 ? i - shots.length : i;
    return Math.abs(d) <= 2 ? String(d) : d < 0 ? 'far-left' : 'far-right';
  };

  const slides = shots
    .map((shot, i) => {
      const pos = startPos(i);
      const onStage = !pos.startsWith('far');

      // A slide parked off-stage sits at opacity 0. Serving it focusable puts
      // the focus ring on an invisible element and reads four unseeable
      // screenshots to a screen reader, so the served state matches what
      // render() maintains — otherwise those attributes are only correct from
      // the first frame of script onward.
      const hidden = onStage ? '' : ' aria-hidden="true"';

      // The centre slide is what a visitor sees first, so it is fetched
      // eagerly at high priority. Its neighbours load normally; everything
      // off-stage is explicitly deprioritised, because all nine images are
      // inside the viewport and would otherwise compete with the hero and the
      // fonts for the same connection.
      const fetch =
        i === 0 ? ' loading="eager" fetchpriority="high"'
        : onStage ? ' loading="lazy"'
        : ' loading="lazy" fetchpriority="low"';

      return `        <button type="button" class="shot" data-shot="${i}" data-pos="${pos}" tabindex="${onStage ? 0 : -1}"${hidden}>
          <span class="sr-only">Screenshot ${i + 1} of ${shots.length}. </span>
          <img src="${SCREENSHOT_DIR}/${shot.id}-${widest}.webp"
               srcset="${screenshotSrcset(shot)}"
               sizes="${SCREENSHOT_SIZES}"
               width="${SCREENSHOT_ASPECT.width}" height="${SCREENSHOT_ASPECT.height}"${fetch}
               decoding="async" draggable="false"
               alt="${escapeHtml(shot.alt)}" />
        </button>`;
    })
    .join('\n');

  const captions = shots
    .map(
      (shot, i) => `        <div class="shot-caption${i === 0 ? ' is-active' : ''}" data-caption="${i}">
          <h3>${inlineMarkdown(shot.title)}</h3>
          <p>${inlineMarkdown(shot.caption)}</p>
        </div>`,
    )
    .join('\n');

  const steps = shots
    .map(
      (shot, i) => `        <button type="button" class="shots-seg${i === 0 ? ' is-active' : ''}" data-step="${i}" aria-label="Show screenshot ${i + 1}: ${escapeHtml(shot.title)}">
          <span class="shots-seg-track"><span class="shots-seg-fill"></span></span>
        </button>`,
    )
    .join('\n');

  return { slides, captions, steps };
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

/* ────────────────────────────────────────────────────────────────────────────
   Support page
   ────────────────────────────────────────────────────────────────────────────
   docs/support.template.html carries the copy and the layout; every payable
   value comes from docs/support-config.json and is rendered here. No M-Pesa
   number, wallet address or share caption is written in the HTML, so changing
   one is an edit to the JSON and a re-run of this script.
   ──────────────────────────────────────────────────────────────────────────── */

interface CryptoEntry {
  coin: string;
  name: string;
  network: string;
  address: string;
  qrImage: string;
}

interface SupportConfig {
  share: { url: string; captions: string[] };
  mpesa: {
    personalNumber: string;
    paybillNumber: string;
    paybillAccount: string;
    /**
     * Name the paybill confirmation shows before the sender enters their PIN.
     * Optional: left as the placeholder, the row is omitted rather than
     * rendered as "Not set yet", because a name is a detail to check against,
     * not a field anyone has to fill in to pay.
     */
    accountName: string;
    /** Destination country for an international transfer, shown in the callout. */
    country: string;
    /** Real copy, never a placeholder — how to reach M-Pesa from abroad. */
    internationalNote: string;
  };
  /**
   * Gates the whole Crypto section. False keeps the heading and shows the cards
   * blurred behind a "coming soon" overlay.
   */
  cryptoEnabled: boolean;
  crypto: CryptoEntry[];
}

/** The literal every field in support-config.json ships as. */
const UNSET = 'REPLACE_ME';

function readSupportConfig(): SupportConfig {
  const config = JSON.parse(readProjectFile('docs/support-config.json')) as SupportConfig;

  if (!config.share?.url) throw new Error('support-config.json: share.url is required');
  if (!Array.isArray(config.share.captions) || config.share.captions.length < 2) {
    throw new Error('support-config.json: share.captions needs at least two entries (X, then WhatsApp)');
  }
  // country and internationalNote are the callout's copy, not payable values,
  // so an empty one is a build error rather than a "Not set yet" placeholder —
  // the callout would otherwise render as an empty box.
  for (const field of ['country', 'internationalNote'] as const) {
    if (!config.mpesa?.[field]?.trim()) {
      throw new Error(`support-config.json: mpesa.${field} is required (it is copy, not a placeholder)`);
    }
  }
  if (!Array.isArray(config.crypto) || config.crypto.length === 0) {
    throw new Error('support-config.json: crypto must list at least one coin');
  }
  for (const entry of config.crypto) {
    for (const field of ['coin', 'name', 'network', 'address', 'qrImage'] as const) {
      if (!entry[field]) throw new Error(`support-config.json: crypto entry ${entry.coin || '?'} is missing ${field}`);
    }
  }
  return config;
}

/** A value that is still the shipped placeholder is rendered, never payable. */
function isUnset(value: string): boolean {
  return !value || value.trim() === '' || value.trim().toUpperCase() === UNSET;
}

/**
 * `escapeHtml` deliberately leaves quotes alone — it feeds element text. Values
 * here also land in `data-copy="…"` attributes, where an unescaped quote would
 * break out of the attribute, so they get their own escaper.
 */
function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const COPY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<rect x="9" y="9" width="12" height="12" rx="2.5"/>' +
  '<path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';

/**
 * One value plus its copy button.
 *
 * A field still holding the placeholder renders as visible, italic "Not set
 * yet" text with the button disabled, rather than as a copyable literal
 * "REPLACE_ME" — a copy button that hands someone a fake account number is
 * worse than an obviously incomplete page.
 */
function renderCopyField(value: string, what: string): string {
  if (isUnset(value)) {
    return `          <div class="pay-value is-unset">
            <code>Not set yet</code>
            <button type="button" class="copy-btn" disabled aria-label="${escapeAttr(what)} is not available yet">
              ${COPY_ICON}<span data-copy-label>Copy</span>
            </button>
          </div>`;
  }

  return `          <div class="pay-value">
            <code>${escapeHtml(value)}</code>
            <button type="button" class="copy-btn" data-copy="${escapeAttr(value)}"
                    data-copy-what="${escapeAttr(what)}" data-copy-idle="Copy"
                    aria-label="Copy ${escapeAttr(what)}">
              ${COPY_ICON}<span data-copy-label>Copy</span>
            </button>
          </div>`;
}

/**
 * The optional account-name row, generated whole so it can be omitted.
 *
 * The other two paybill rows carry a static label in the template because they
 * always render. This one does not: a paybill is payable without it, so an
 * unset name drops the row entirely rather than printing "Not set yet" beside
 * a value nobody needs in order to send.
 */
function renderAccountNameField(name: string): string {
  if (isUnset(name)) return '';
  return `        <div class="pay-field">
          <span class="pay-field-label">Account name</span>
${renderCopyField(name, 'Account name')}
        </div>`;
}

/**
 * Share icons, drawn here rather than read from docs/assets/icons/.
 *
 * That directory holds the three Font Awesome platform marks, which are
 * inlined by buildIconSvg so they can inherit currentColor. These five are
 * plain stroke glyphs in the same style as the page's other UI icons, and each
 * button carries a text label ("Share on Facebook"), so the glyph identifies
 * rather than having to stand alone as a brand mark.
 */
const SHARE_ICONS: Record<string, string> = {
  x: '<path d="M4 4l16 16M20 4L4 20"/>',
  facebook:
    '<rect x="3" y="3" width="18" height="18" rx="4"/>' +
    '<path d="M14.5 8.5h-1.2a1.3 1.3 0 0 0-1.3 1.3V21"/><path d="M10 13.2h4"/>',
  linkedin:
    '<rect x="3" y="3" width="18" height="18" rx="4"/>' +
    '<path d="M7.5 10.5V17"/><path d="M7.5 7.5v.01"/>' +
    '<path d="M11.5 17v-4a2.5 2.5 0 0 1 5 0v4"/><path d="M11.5 10.5V17"/>',
  whatsapp:
    '<path d="M3.5 20.5l1.3-4a8 8 0 1 1 3.2 3.1z"/>' +
    '<path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l.8-1.4-2-.9-.9.9a5.6 5.6 0 0 1-2-2l.9-.9-.9-2z"/>',
  link: '<path d="M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7l-1.3 1.3"/>' +
    '<path d="M14 10.5a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.3-1.3"/>',
};

function shareIcon(name: string): string {
  const inner = SHARE_ICONS[name];
  if (!inner) throw new Error(`No share icon named ${name}`);
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`
  );
}

/**
 * The five share controls.
 *
 * Facebook and LinkedIn take a URL only: both strip caller-supplied text from
 * their share intents and render the target page's own og: tags instead, so
 * passing a caption to them would be dead config that looks live. The captions
 * go where they are actually honoured — captions[0] to X, captions[1] to
 * WhatsApp, which is the more conversational of the two.
 */
function buildShareButtonsHtml(share: SupportConfig['share']): string {
  const url = encodeURIComponent(share.url);
  const [xCaption, waCaption] = share.captions;

  const links: Array<{ icon: string; label: string; href: string }> = [
    {
      icon: 'x',
      label: 'Share on X',
      href: `https://twitter.com/intent/tweet?text=${encodeURIComponent(xCaption)}&url=${url}`,
    },
    {
      icon: 'facebook',
      label: 'Share on Facebook',
      href: `https://www.facebook.com/sharer/sharer.php?u=${url}`,
    },
    {
      icon: 'linkedin',
      label: 'Share on LinkedIn',
      href: `https://www.linkedin.com/sharing/share-offsite/?url=${url}`,
    },
    {
      icon: 'whatsapp',
      label: 'Share on WhatsApp',
      href: `https://wa.me/?text=${encodeURIComponent(`${waCaption} ${share.url}`)}`,
    },
  ];

  const anchors = links.map(
    (link) => `      <a class="share-btn" href="${escapeAttr(link.href)}" target="_blank" rel="noopener">
        ${shareIcon(link.icon)}${escapeHtml(link.label)}
      </a>`,
  );

  // The copy-link control is a button, not an anchor: it navigates nowhere.
  // It reuses the same delegated data-copy handler as the payment fields.
  anchors.push(`      <button type="button" class="share-btn" data-copy="${escapeAttr(share.url)}"
              data-copy-what="Link" data-copy-idle="Copy link">
        ${shareIcon('link')}<span data-copy-label>Copy link</span>
      </button>`);

  return anchors.join('\n');
}

/**
 * One card per entry in support-config.json's `crypto` array.
 *
 * The network warning is built from the entry's own `coin` and `network`, so it
 * cannot describe a different chain from the address printed above it.
 */
function buildCryptoCardsHtml(entries: CryptoEntry[], enabled: boolean): string {
  return entries
    .map((rawEntry) => {
      // With the section switched off, the address never reaches the HTML. The
      // blur is decoration; `view-source:` and Ctrl+U are not affected by CSS,
      // so a real address published behind one would simply be published.
      const entry = enabled ? rawEntry : { ...rawEntry, address: UNSET };
      const warning =
        `Only send <strong>${escapeHtml(entry.coin)}</strong> on the ` +
        `<strong>${escapeHtml(entry.network)}</strong> network to this address.`;

      return `      <div class="pay-card">
        <div class="crypto-top">
          <div class="crypto-title">
            <h3>${escapeHtml(entry.name)} <span class="ticker">${escapeHtml(entry.coin)}</span></h3>
            <div class="crypto-meta">
              <span class="tag tag-violet">${escapeHtml(entry.network)}</span>
              <span class="tag tag-muted">${escapeHtml(entry.coin)}</span>
            </div>
          </div>
          <div class="qr-frame">
            <img class="crypto-qr" src="${escapeAttr(entry.qrImage)}" width="96" height="96"
                 loading="lazy" decoding="async" draggable="false"
                 alt="QR code for the ${escapeAttr(entry.name)} address on the ${escapeAttr(entry.network)} network" />
            <span class="qr-fallback" aria-hidden="true">QR<br />soon</span>
          </div>
        </div>
        <div class="pay-field">
          <span class="pay-field-label">${escapeHtml(entry.network)} address</span>
${renderCopyField(entry.address, `${entry.coin} address`)}
        </div>
        <p class="crypto-warn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12" y2="17"/></svg>
          <span>${warning}</span>
        </p>
      </div>`;
    })
    .join('\n');
}

/**
 * The Crypto section's body and its intro line, in whichever of the two states
 * `cryptoEnabled` selects.
 *
 * The heading stays in the template either way — only what sits under it
 * changes — so the section never disappears from the page or the nav.
 */
function buildCryptoSection(config: SupportConfig): { intro: string; body: string } {
  const cards = buildCryptoCardsHtml(config.crypto, config.cryptoEnabled);

  if (config.cryptoEnabled) {
    return {
      intro:
        'Scan the code or copy the address. Check the network on every card before you ' +
        'send — coins sent on the wrong chain are not recoverable by anyone, including me.',
      body: `    <div class="crypto-shell">
      <div class="crypto-grid">
${cards}
      </div>
    </div>`,
    };
  }

  // aria-hidden on the grid, because a blurred card is not content: a screen
  // reader would otherwise announce four coins and four "Not set yet" address
  // fields that nobody can see or use. The overlay carries the real message and
  // stays outside it, so it is the one thing announced here.
  return {
    intro: 'Not quite ready — the wallets are being set up. M-Pesa above works today.',
    body: `    <div class="crypto-shell is-disabled">
      <div class="crypto-grid" aria-hidden="true">
${cards}
      </div>
      <div class="crypto-soon">
        <span class="crypto-soon-badge">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>
          Coming soon
        </span>
        <p class="crypto-soon-text">Crypto support coming soon</p>
      </div>
    </div>`,
  };
}

function buildSupportPage(version: string, colors: BrandTokens['colors']): void {
  const config = readSupportConfig();
  const crypto = buildCryptoSection(config);

  const template = readFileSync(join(docsDir, 'support.template.html'), 'utf-8');
  const rendered = template
    .split('{{VERSION}}').join(version)
    .split('{{SHARE_BUTTONS}}').join(buildShareButtonsHtml(config.share))
    .split('{{MPESA_PERSONAL_FIELD}}').join(renderCopyField(config.mpesa.personalNumber, 'M-Pesa phone number'))
    .split('{{MPESA_PAYBILL_FIELD}}').join(renderCopyField(config.mpesa.paybillNumber, 'Paybill number'))
    .split('{{MPESA_ACCOUNT_FIELD}}').join(renderCopyField(config.mpesa.paybillAccount, 'Paybill account number'))
    .split('{{MPESA_ACCOUNT_NAME_FIELD}}').join(renderAccountNameField(config.mpesa.accountName))
    .split('{{MPESA_COUNTRY}}').join(escapeHtml(config.mpesa.country))
    .split('{{MPESA_INTERNATIONAL_NOTE}}').join(escapeHtml(config.mpesa.internationalNote))
    .split('{{CRYPTO_INTRO}}').join(escapeHtml(crypto.intro))
    .split('{{CRYPTO_BODY}}').join(crypto.body)
    .split('{{BRAND_VIOLET}}').join(colors.violet)
    .split('{{BRAND_VIOLET_BRIGHT}}').join(colors.violetBright)
    .split('{{BRAND_PINK}}').join(colors.pink)
    .split('{{BRAND_PINK_BRIGHT}}').join(colors.pinkBright)
    .split('{{BRAND_AMBER}}').join(colors.amber)
    .split('{{BRAND_AMBER_BRIGHT}}').join(colors.amberBright);

  writeFileSync(join(docsDir, 'support.html'), rendered, 'utf-8');

  // Say plainly which values are still placeholders. The page renders them as
  // "Not set yet" with the copy button disabled, so this is a reminder rather
  // than a failure — the page is publishable and simply advertises less.
  const pending = [
    isUnset(config.mpesa.personalNumber) && 'mpesa.personalNumber',
    isUnset(config.mpesa.paybillNumber) && 'mpesa.paybillNumber',
    isUnset(config.mpesa.paybillAccount) && 'mpesa.paybillAccount',
    // Listed even though the row is optional: left as the placeholder it
    // disappears from the page silently, which is worth one line of warning.
    isUnset(config.mpesa.accountName) && 'mpesa.accountName (row omitted)',
    // Only while the section is live. With cryptoEnabled false the addresses
    // are *meant* to be unset, so listing them would be noise that trains
    // whoever runs this to ignore the warning line.
    ...(config.cryptoEnabled
      ? config.crypto.map((entry) => isUnset(entry.address) && `crypto.${entry.coin}.address`)
      : []),
  ].filter((name): name is string => typeof name === 'string');

  console.log(
    `Built docs/support.html for v${version} ` +
      `(${config.share.captions.length} share captions, crypto ` +
      `${config.cryptoEnabled ? `live with ${config.crypto.length} coins` : `off — ${config.crypto.length} coins staged, addresses withheld`})`,
  );
  if (pending.length > 0) {
    console.log(`  ! still placeholders in docs/support-config.json: ${pending.join(', ')}`);
  }
}

function main(): void {
  const version = resolveVersion();
  const changelogHtml = buildChangelogHtml();
  const screenshots = buildScreenshotsHtml();
  const { colors } = readBrandTokens();

  const template = readFileSync(join(docsDir, 'index.template.html'), 'utf-8');
  const rendered = template
    .split('{{VERSION}}').join(version)
    .split('{{CHANGELOG_HTML}}').join(changelogHtml)
    .split('{{SCREENSHOT_SLIDES}}').join(screenshots.slides)
    .split('{{SCREENSHOT_CAPTIONS}}').join(screenshots.captions)
    .split('{{SCREENSHOT_STEPS}}').join(screenshots.steps)
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
  const slideCount = (screenshots.slides.match(/class="shot"/g) || []).length;
  console.log(
    `Built docs/index.html for v${version} ` +
      `(${changelogHtml ? 'changelog injected' : 'no changelog entries found'}, ${slideCount} screenshots)`,
  );

  // Every page the site serves is generated by this one script, so
  // `npm run build:site` stays the single command and no workflow has to learn
  // a second one.
  buildSupportPage(version, colors);
}

main();

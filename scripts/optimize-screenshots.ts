// Role: turn the raw app captures in Screenshots/ into the web assets the site
// serves from docs/assets/screenshots/.
//
// The originals are 2544x1644 PNGs, ~1.4 MB each and 14 MB for the set — an
// unusable payload for a landing page whose entire current weight is a few
// hundred KB of HTML. Each one is re-encoded to WebP at two widths so the
// browser can pick: 800w for the phone frame and the small side slides, 1600w
// for the magnified centre slide on a HiDPI desktop. Nothing is rendered above
// 1600 because nothing on the page is ever displayed wider than ~860 CSS px.
//
// Playwright does the encoding for the same reason generate-icons.ts uses it to
// rasterize: it is already a devDependency and is the only image pipeline in
// this repo. Chromium's canvas writes WebP directly, so this needs no native
// module (sharp and friends would be a new dependency for a script that runs by
// hand a few times a year).
//
// Manual, like `npm run icons:build` — a normal build and CI never need a
// browser. The source PNGs are deliberately NOT committed: 14 MB of binaries in
// git to regenerate ~1 MB of assets is a bad trade, so the committed artifact is
// the .webp set and this script is what you run when you add to it. If the
// source directory is missing, that is what the error says.
//
// Usage: npm run screenshots:build [-- <source-dir>]
import { chromium, type Browser, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { repoRoot } from './lib/changelog';
import { readShots, SCREENSHOT_WIDTHS } from './lib/screenshots';

/**
 * WebP quality. 0.82 sits at the knee for this material: these are flat, dark
 * UI screenshots with hard text edges, and dropping to 0.7 starts to fringe the
 * 12px labels while saving very little.
 */
const QUALITY = 0.82;

/*
 * The encode step below runs inside Chromium, not in Node, so it needs DOM
 * globals that scripts/ deliberately does not have: tsconfig.electron.json
 * compiles this directory with `lib: ["ES2022"]` because everything else in it
 * is main-process or build code. A project-wide `/// <reference lib="dom" />`
 * would hand `document` and friends to every Electron main-process file too,
 * so only the three members actually used are declared, and only here.
 */
declare const document: {
  createElement(tag: 'canvas'): {
    width: number;
    height: number;
    getContext(contextId: '2d'): {
      imageSmoothingQuality: string;
      drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void;
    } | null;
    toDataURL(type: string, quality: number): string;
  };
};

declare const Image: new () => {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  decode(): Promise<void>;
};

/**
 * Re-encodes one PNG to WebP at `width`, preserving its aspect ratio.
 *
 * The PNG goes in as a data URL rather than a file:// reference on purpose: a
 * file:// image taints the canvas, and a tainted canvas throws on toDataURL.
 */
async function encode(page: Page, png: Buffer, width: number): Promise<Buffer> {
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;

  const encoded = await page.evaluate(
    async ({ src, targetWidth, quality }) => {
      const img = new Image();
      img.src = src;
      await img.decode();

      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = Math.round((img.naturalHeight / img.naturalWidth) * targetWidth);

      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      return canvas.toDataURL('image/webp', quality);
    },
    { src: dataUrl, targetWidth: width, quality: QUALITY },
  );

  // Chromium silently hands back a PNG data URL when it cannot encode the
  // requested type, which would ship 4x the bytes under a .webp name.
  if (!encoded.startsWith('data:image/webp;base64,')) {
    throw new Error(`Chromium did not produce WebP (got "${encoded.slice(0, 30)}…")`);
  }
  return Buffer.from(encoded.slice('data:image/webp;base64,'.length), 'base64');
}

async function main(): Promise<void> {
  // resolve(), not join(): the argument is as often an absolute path as a relative one.
  const sourceDir = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : join(repoRoot, 'Screenshots');
  const outDir = join(repoRoot, 'docs', 'assets', 'screenshots');

  if (!existsSync(sourceDir)) {
    throw new Error(
      `Source screenshots not found at ${sourceDir}. They are not committed — ` +
        'point this script at the folder holding the raw captures, e.g. ' +
        '`npm run screenshots:build -- ../Screenshots`.',
    );
  }

  const shots = readShots();

  // Every source is checked before anything is written, because the next step
  // clears the output directory: a missing file discovered halfway through
  // would otherwise leave the committed assets deleted and only partly
  // rewritten.
  const missing = shots.filter((shot) => !existsSync(join(sourceDir, shot.source)));
  if (missing.length > 0) {
    throw new Error(
      `docs/screenshots.json lists ${missing.length} file(s) not in ${sourceDir}: ` +
        missing.map((shot) => `"${shot.source}"`).join(', '),
    );
  }

  // Rebuilt from scratch, like generate-icons.ts does with assets/icons/, so a
  // shot removed from the JSON cannot linger as an orphaned .webp that nothing
  // references and every visitor still downloads if a stale page asks for it.
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const browser: Browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let total = 0;
    let sourceBytes = 0;

    for (const shot of shots) {
      const png = readFileSync(join(sourceDir, shot.source));
      sourceBytes += png.length;

      for (const width of SCREENSHOT_WIDTHS) {
        const webp = await encode(page, png, width);

        // A "successful" encode that produced a few hundred bytes is a blank
        // canvas — the image failed to decode and nothing was drawn.
        if (webp.length < 4096) {
          throw new Error(`${shot.id}-${width}.webp is only ${webp.length} bytes; the source likely failed to decode`);
        }
        writeFileSync(join(outDir, `${shot.id}-${width}.webp`), webp);
        total += webp.length;
        console.log(`Wrote docs/assets/screenshots/${shot.id}-${width}.webp (${Math.round(webp.length / 1024)} KB)`);
      }
    }

    console.log(
      `\n${shots.length} screenshots x ${SCREENSHOT_WIDTHS.length} widths = ` +
        `${Math.round(total / 1024)} KB, from ${Math.round(sourceBytes / 1024)} KB of source PNGs.`,
    );
  } finally {
    await browser.close();
  }
}

await main();

// Role: rasterize assets/icon.svg into the PNG electron-builder packages.
//
// assets/icon.png was 256x256, which is below the 512x512 minimum
// electron-builder enforces when converting an icon to .icns. That made the
// macOS build fail immediately — a failure nobody had seen, because the CI
// build jobs list `verify-engine` in their `needs` and had been skipped for as
// long as that job was red.
//
// Rendering from the SVG keeps assets/icon.svg the single source of truth, so
// the PNG cannot drift from the canonical mark the way a hand-exported file
// would. Playwright is already a devDependency and is the only rasterizer
// available here; this script is manual (`npm run icons:build`), not part of
// the build, so a normal build never needs a browser.
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '..');

/** 1024 is Apple's largest icon slot; electron-builder downsamples the rest. */
const SIZE = 1024;

async function main(): Promise<void> {
  const svgPath = join(root, 'assets', 'icon.svg');
  const outPath = join(root, 'assets', 'icon.png');
  const svg = readFileSync(svgPath, 'utf-8');

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: SIZE, height: SIZE },
      deviceScaleFactor: 1,
    });

    // The mark is drawn edge-to-edge with rounded corners, so the page must be
    // transparent or the corners pick up a white fringe.
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent">
         <div id="mark" style="width:${SIZE}px;height:${SIZE}px">${svg}</div>
       </body></html>`,
      { waitUntil: 'load' },
    );
    await page.addStyleTag({
      content: `#mark svg { width: ${SIZE}px; height: ${SIZE}px; display: block; }`,
    });

    const png = await page.locator('#mark').screenshot({ omitBackground: true });
    writeFileSync(outPath, png);

    // Fail loudly rather than silently shipping an undersized icon again.
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    if (width < 512 || height < 512) {
      throw new Error(`Rendered icon is ${width}x${height}; electron-builder requires at least 512x512 for macOS.`);
    }

    console.log(`Wrote assets/icon.png (${width}x${height}, ${png.length} bytes) from assets/icon.svg`);
  } finally {
    await browser.close();
  }
}

await main();

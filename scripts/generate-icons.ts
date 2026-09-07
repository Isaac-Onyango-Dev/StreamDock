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
//
// It also writes assets/icons/, the multi-size set electron-builder needs for
// Linux. electron-builder downsamples a single PNG when it builds a macOS
// .icns or a Windows .ico, but for Linux it copies only the sizes it is given
// — so a lone 1024x1024 file was installed to
// usr/share/icons/hicolor/1024x1024/, a directory the freedesktop hicolor
// index does not list (it stops at 512x512). The icon therefore resolved to
// nothing and every Linux desktop fell back to a generic icon. Verified on
// Ubuntu 26.04: Gtk.IconTheme.lookup_icon('streamdock', 48) returned NOT FOUND
// with only the 1024 file installed, and resolved as soon as an indexed size
// was present.
import { chromium, type Browser } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '..');

/** 1024 is Apple's largest icon slot; electron-builder downsamples the rest. */
const SIZE = 1024;

/**
 * Sizes written to assets/icons/ for the Linux build.
 *
 * Every one of these is a directory the freedesktop hicolor index actually
 * lists, which is the whole point — an icon installed at a size the theme does
 * not index is invisible to the desktop. electron-builder reads this directory
 * when `build.linux.icon` points at it and names each entry `<w>x<h>.png`.
 */
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

/** Rasterizes assets/icon.svg at one square size. */
async function render(browser: Browser, svg: string, size: number): Promise<Buffer> {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  try {
    // The mark is drawn edge-to-edge with rounded corners, so the page must be
    // transparent or the corners pick up a white fringe.
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent">
         <div id="mark" style="width:${size}px;height:${size}px">${svg}</div>
       </body></html>`,
      { waitUntil: 'load' },
    );
    await page.addStyleTag({
      content: `#mark svg { width: ${size}px; height: ${size}px; display: block; }`,
    });
    return await page.locator('#mark').screenshot({ omitBackground: true });
  } finally {
    await page.close();
  }
}

async function main(): Promise<void> {
  const svgPath = join(root, 'assets', 'icon.svg');
  const outPath = join(root, 'assets', 'icon.png');
  const iconsDir = join(root, 'assets', 'icons');
  const svg = readFileSync(svgPath, 'utf-8');

  const browser = await chromium.launch();
  try {
    const png = await render(browser, svg, SIZE);
    writeFileSync(outPath, png);

    // Fail loudly rather than silently shipping an undersized icon again.
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    if (width < 512 || height < 512) {
      throw new Error(`Rendered icon is ${width}x${height}; electron-builder requires at least 512x512 for macOS.`);
    }

    console.log(`Wrote assets/icon.png (${width}x${height}, ${png.length} bytes) from assets/icon.svg`);

    // Rebuilt from scratch so a size dropped from LINUX_SIZES cannot linger as
    // a stale file that still gets packaged.
    rmSync(iconsDir, { recursive: true, force: true });
    mkdirSync(iconsDir, { recursive: true });

    for (const size of LINUX_SIZES) {
      const buf = await render(browser, svg, size);
      const name = `${size}x${size}.png`;
      writeFileSync(join(iconsDir, name), buf);
      console.log(`Wrote assets/icons/${name} (${buf.length} bytes)`);
    }
  } finally {
    await browser.close();
  }
}

await main();

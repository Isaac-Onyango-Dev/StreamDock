// Role: render the Windows installer's artwork from the brand, as the 24-bit
// BMPs NSIS requires.
//
// The installer had no artwork of its own, so every Welcome/Finish page showed
// NSIS's stock nsis3-metro.bmp — a blue panel that belongs to no product — next
// to a white page, in a window Windows bitmap-stretched to 125% because the
// installer was not DPI-aware. The brand colours come from design/tokens.json
// and the mark from assets/icon.svg, the sources the app and the site already
// share, so the installer cannot drift from them.
//
// The art is drawn 1:1 by the installer (build/installer.nsh asks for
// NoStretchNoCrop), because NSIS stretches bitmaps with nearest-neighbour and a
// stretched mark comes out jagged. Its right and bottom edges fade into the
// page colour, so at 125% or 150% scaling, where the control is larger than the
// bitmap, the art simply ends in the same colour as the page around it.
//
// Manual, like `icons:build`: `npm run installer:art`. It needs a browser and,
// for the display font, the network; a normal build needs neither, because the
// BMPs are committed.
import { chromium, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '..');
const outDir = join(root, 'build');

/** NSIS Modern UI's documented sizes. */
export const SIDEBAR = { width: 164, height: 314 } as const;
export const HEADER = { width: 150, height: 57 } as const;

const tokens = JSON.parse(readFileSync(join(root, 'design', 'tokens.json'), 'utf-8')) as {
  colors: Record<'violet' | 'violetBright' | 'pink' | 'amber' | 'ink', string>;
};
const { violet, pink, amber, ink } = tokens.colors;

/** `#8B5CF6` + 0.55 → `rgba(139, 92, 246, 0.55)` */
function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&display=block';
const MARK = readFileSync(join(root, 'assets', 'icon.svg'), 'utf-8');

/*
 * The decode step runs inside Chromium. scripts/ compiles without DOM types
 * (it is Node code), so, as in optimize-screenshots.ts, only the members used
 * are declared, and only here.
 */
declare const document: {
  fonts: { load(font: string): Promise<unknown>; check(font: string): boolean };
  createElement(tag: 'canvas'): {
    width: number;
    height: number;
    getContext(contextId: '2d'): {
      drawImage(image: unknown, dx: number, dy: number): void;
      getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> };
    } | null;
  };
};
declare const Image: new () => { src: string; width: number; height: number; decode(): Promise<void> };

/** The app's default background (client/src/styles/backgrounds.css, "gradient"), fitted to a tall panel. */
const SIDEBAR_HTML = `
  <div id="art" style="position:relative;width:${SIDEBAR.width}px;height:${SIDEBAR.height}px;overflow:hidden;background:${ink};
       background-image:
         radial-gradient(rgba(167,139,250,0.08) 1px, transparent 1px),
         radial-gradient(ellipse 95% 45% at 0% 0%, ${alpha(violet, 0.6)}, transparent 70%),
         radial-gradient(ellipse 80% 40% at 100% 38%, ${alpha(pink, 0.42)}, transparent 70%),
         radial-gradient(ellipse 100% 35% at 30% 100%, ${alpha(amber, 0.3)}, transparent 70%);
       background-size: 14px 14px, cover, cover, cover;">
    <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;padding-top:74px;gap:14px;">
      <div class="mark" style="width:64px;height:64px;filter:drop-shadow(0 6px 18px ${alpha(violet, 0.55)})">${MARK}</div>
      <div style="font:700 21px 'Space Grotesk';letter-spacing:-0.3px;color:#F3F0FF;">Stream<span style="
        background:linear-gradient(120deg, ${violet} 0%, ${pink} 55%, ${amber} 100%);
        -webkit-background-clip:text;background-clip:text;color:transparent;">Dock</span></div>
    </div>
    <div style="position:absolute;inset:0;background:
      linear-gradient(to right, transparent 80%, ${ink} 100%),
      linear-gradient(to bottom, transparent 84%, ${ink} 100%);"></div>
  </div>`;

/** The top band of every inner page: the mark on the page colour, fading in from the left. */
const HEADER_HTML = `
  <div id="art" style="position:relative;width:${HEADER.width}px;height:${HEADER.height}px;overflow:hidden;background:${ink};
       background-image: radial-gradient(ellipse 55% 95% at 78% 50%, ${alpha(violet, 0.38)}, transparent 72%),
                         radial-gradient(ellipse 35% 80% at 96% 20%, ${alpha(pink, 0.28)}, transparent 72%);">
    <div class="mark" style="position:absolute;right:14px;top:${(HEADER.height - 34) / 2}px;width:34px;height:34px;">${MARK}</div>
  </div>`;

async function renderRgba(page: Page, html: string, width: number, height: number): Promise<Uint8Array> {
  await page.setViewportSize({ width, height });
  await page.setContent(
    `<!doctype html><html><head><link rel="stylesheet" href="${FONT_CSS}">
       <style>html,body{margin:0;background:${ink}} .mark svg{width:100%;height:100%;display:block}</style>
     </head><body>${html}</body></html>`,
    { waitUntil: 'networkidle' },
  );
  // `document.fonts.ready` can resolve before layout has even asked for the
  // face; loading it by name is what actually waits for the file.
  await page.evaluate(() => document.fonts.load("700 21px 'Space Grotesk'"));
  // A fallback font would ship silently; refuse instead.
  if (!(await page.evaluate(() => document.fonts.check("700 21px 'Space Grotesk'")))) {
    throw new Error('Space Grotesk did not load (no network?); refusing to render the wordmark in a fallback font.');
  }
  const png = await page.locator('#art').screenshot();
  const data = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    return Array.from(ctx.getImageData(0, 0, img.width, img.height).data);
  }, png.toString('base64'));
  if (data.length !== width * height * 4) throw new Error(`Rendered ${data.length / 4} pixels, expected ${width}x${height}`);
  return Uint8Array.from(data);
}

/**
 * An uncompressed 24-bit BMP: what NSIS's LoadImage accepts. Rows are stored
 * bottom-up, as BGR, each padded to a multiple of four bytes.
 */
export function toBmp24(width: number, height: number, rgba: Uint8Array): Buffer {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const bmp = Buffer.alloc(54 + pixelBytes);
  bmp.write('BM', 0, 'ascii');
  bmp.writeUInt32LE(54 + pixelBytes, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(pixelBytes, 34);
  bmp.writeInt32LE(2835, 38);
  bmp.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      bmp[row + x * 3] = rgba[src + 2];
      bmp[row + x * 3 + 1] = rgba[src + 1];
      bmp[row + x * 3 + 2] = rgba[src];
    }
  }
  return bmp;
}

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const [name, html, size] of [
      ['installerSidebar.bmp', SIDEBAR_HTML, SIDEBAR],
      ['installerHeader.bmp', HEADER_HTML, HEADER],
    ] as const) {
      const bmp = toBmp24(size.width, size.height, await renderRgba(page, html, size.width, size.height));
      writeFileSync(join(outDir, name), bmp);
      console.log(`Wrote build/${name} (${size.width}x${size.height}, ${bmp.length} bytes)`);
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1]?.endsWith('generate-installer-art.ts')) await main();

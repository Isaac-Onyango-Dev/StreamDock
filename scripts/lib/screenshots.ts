// The screenshot carousel's data, read by everything that touches it:
// optimize-screenshots.ts encodes the sources listed here, build-site.ts
// generates the slides from them, and verify-engine.ts checks the page against
// them. One reader, so a shot cannot be encoded under one name and rendered
// under another — the changelog spent months rendered through two parsers, one
// of which silently truncated it, and this is the same shape of hazard.
import { join } from 'path';
import { readProjectFile } from './changelog';

export interface ShotEntry {
  /** Basename of the generated web assets, and the slide's stable id. */
  id: string;
  /** Filename inside the committed `Screenshots/` folder at the repo root. */
  source: string;
  /** Caption heading. */
  title: string;
  /** One or two sentences under the heading. */
  caption: string;
  /** What the image shows, for anyone who cannot see it. */
  alt: string;
}

/**
 * Widths written per shot, and the widths the generated `srcset` offers.
 *
 * Measured against what browsers actually pick, not guessed:
 *  - 800 is what a phone (80vw ≈ 312 CSS px at DPR 2-3) and a 1x tablet take.
 *  - 1200 is what a 1x desktop takes — `sizes` claims 860 px there, and with
 *    only 800/1600 on offer every one of the nine slides was fetched at 1600,
 *    493 KB for the set. This candidate is the one that case actually needs.
 *  - 1600 covers a HiDPI desktop, the widest the centre slide is ever shown at.
 *
 * Every consumer reads this list, so adding a width encodes it, offers it in
 * the srcset and checks it in verify-engine in one edit.
 */
export const SCREENSHOT_WIDTHS = [800, 1200, 1600] as const;

/** Where the generated assets live, relative to the published site root. */
export const SCREENSHOT_DIR = 'assets/screenshots';

const REQUIRED: Array<keyof ShotEntry> = ['id', 'source', 'title', 'caption', 'alt'];

/** Reads and validates docs/screenshots.json, in page order. */
export function readShots(): ShotEntry[] {
  const parsed = JSON.parse(readProjectFile(join('docs', 'screenshots.json'))) as { shots?: ShotEntry[] };
  const shots = parsed.shots;

  if (!Array.isArray(shots) || shots.length === 0) {
    throw new Error('docs/screenshots.json has no `shots` array');
  }

  const seen = new Set<string>();
  for (const shot of shots) {
    for (const field of REQUIRED) {
      if (typeof shot?.[field] !== 'string' || shot[field].trim() === '') {
        throw new Error(`A shot in docs/screenshots.json is missing "${field}"`);
      }
    }
    // An id collision would silently overwrite one shot's assets with
    // another's and render the same picture twice.
    if (seen.has(shot.id)) throw new Error(`docs/screenshots.json uses the id "${shot.id}" twice`);
    seen.add(shot.id);
  }

  return shots;
}

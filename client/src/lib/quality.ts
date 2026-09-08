// Role: turn detected source resolutions into the options the picker offers.
//
// The picker used to fall back to a hardcoded 1080p/720p/480p/360p list whenever
// nothing had been detected — which is before Analyze has run, for every
// playlist, and for every episode-range probe, because the probe only fills in
// qualityOptions when it resolved a single item. So the list a user saw was
// usually not the source's, and picking "1080p" for a source topping out at 480p
// looked like a supported choice.
//
// Detection itself was never the problem. This module's rule is simply that an
// option is offered only when a source actually reported that height.
//
// The format strings are deliberately ceilings (`height<=N`), not equalities.
// Verified against the engine on two videos with different maximum resolutions,
// under one shared selector:
//
//   -f 'bestvideo[height<=1080]+bestaudio/best[height<=1080]'
//     → 240p-max video downloaded at 240p   (not skipped, not upscaled)
//     → 720p-max video downloaded at 720p
//
// That is what makes "up to 1080p" honest for a playlist: yt-dlp evaluates the
// selector per entry, so each episode lands at its own best within the cap.

export type CaptureMode = 'video' | 'stream';

export interface QualityChoice {
  /** What the picker shows. */
  label: string;
  /** The yt-dlp -f expression, or '' for "let the engine pick the best". */
  value: string;
}

/**
 * The yt-dlp format expression for a height ceiling.
 *
 * `height<=N` rather than `height=N` on purpose: a strict match would make an
 * episode that lacks the exact resolution fail or be skipped, which is the one
 * behaviour users find genuinely surprising.
 */
export function buildQualityValue(mode: CaptureMode, height: number): string {
  if (mode === 'video') {
    return `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`;
  }
  return `best[height<=${height}]/best`;
}

/** The always-present first entry: best available, resolved per item. */
export const BEST_QUALITY: QualityChoice = { label: 'Best quality', value: '' };

/**
 * Options to offer for the heights a source actually reported.
 *
 * An empty or unknown set yields just "Best quality" — never an invented ladder.
 * Labels say "up to N" because that is what the format string does; calling it
 * plain "1080p" is what made a legitimate downgrade look like a silent failure.
 */
export function buildQualityChoices(
  mode: CaptureMode,
  detectedHeights: Iterable<number>,
): QualityChoice[] {
  const heights = Array.from(new Set(Array.from(detectedHeights)))
    .filter((height) => Number.isFinite(height) && height > 0)
    .sort((a, b) => b - a);

  return [
    BEST_QUALITY,
    ...heights.map((height) => ({
      label: `up to ${height}p`,
      value: buildQualityValue(mode, height),
    })),
  ];
}

/**
 * How a set of per-item heights will actually resolve under a chosen cap.
 *
 * Used to tell the user what will happen *before* they download, so a mixed
 * playlist never produces a surprise. `cap` of null means "Best quality".
 */
export function summarizeQualitySpread(
  itemMaxHeights: number[],
  cap: number | null,
): { height: number; count: number }[] {
  const tally = new Map<number, number>();
  for (const max of itemMaxHeights) {
    if (!Number.isFinite(max) || max <= 0) continue;
    const resolved = cap === null ? max : Math.min(max, cap);
    tally.set(resolved, (tally.get(resolved) ?? 0) + 1);
  }
  return Array.from(tally.entries())
    .map(([height, count]) => ({ height, count }))
    .sort((a, b) => b.height - a.height);
}

/** The numeric ceiling a choice encodes, or null for "Best quality". */
export function capFromQualityValue(value: string): number | null {
  const match = value.match(/height<=(\d+)/);
  return match ? Number(match[1]) : null;
}

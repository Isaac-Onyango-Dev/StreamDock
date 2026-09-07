# Changelog

All notable changes to StreamDock are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-09-07

### Added
- Language labeling for dub/sub/server stream options — every stream choice
  now shows an explicit language badge (e.g. "English Dub", "Japanese Sub"),
  with a clear "Unknown" fallback instead of generic "Stream 2"/"Stream 3"
  labels.
- Advisory source-status check: a dismissible, non-blocking toast flags
  reference-only sites (e.g. `everythingmoe.com`) before you try to download
  from them, instead of letting the attempt silently fail.

### Fixed
- The full test suite was silently collecting **zero tests** — a Vitest setup
  bug threw on Node 19+ and was swallowed. Every fix below shipped without a
  safety net until this was found and repaired.
- Fragmented MP4 streams (`fragment.mp4`) were misclassified as plain MP4,
  applying the wrong concurrent-fragment download strategy.
- YouTube Live's specific handling was unreachable, shadowed by a generic
  live-host check that ran first.
- `sanitizeName()` collapsed illegal characters one-by-one instead of per
  run, and season-folder templates were leaking into raw manifest/CDN
  downloads where they could never resolve.
- Windows `.part` file cleanup was broken (a falsy-index bug meant the
  backslash path separator branch never ran on Windows).
- Manifest-retry downloads could end up named literally
  `Extracting stream manifest….mp4`.
- Unbounded wallpaper cache growth — old daily wallpapers were never cleaned
  up; "most recent" selection now uses actual file mtime instead of
  directory read order.
- Reference-only sites were listed correctly as reference-only in the URL
  router, but were *also* present in the host lists that drive real
  extraction, so playlist inspection and the download engine would still
  attempt to treat them as downloadable content. Closed on every code path,
  with a hard guard added to the download engine's `start()`.
- Output naming now matches the exact required spec (`Episode (1).format`,
  unpadded `Season 1`, no folder for single videos) instead of yt-dlp's own
  zero-padded templates. Re-downloads now skip instead of silently
  overwriting (`--no-overwrites`).
- App boot sequence could silently fail to ever show a window: wallpaper
  cache/protocol setup ran before window creation with no error handling.
  Reordered so the window always appears first, with wallpaper setup
  isolated in its own try/catch.
- Assorted: a TypeScript compile error and a masked config-load fallback bug
  in the URL router; forbidden `require()` calls, dead code, and `any` types
  cleaned up for a zero-warning lint gate.

## [1.0.2] - 2026-06-14

### Fixed
- Settings toggle alignment — the thumb now slides end-to-end correctly.
- GitHub Pages updated to reflect the current version and feature set.

## [1.0.1] - 2026-06-14

### Added
- Bing daily wallpaper with live auto-refresh.
- Configurable wallpaper refresh interval (1h–48h) with a live countdown
  timer.
- Custom background color picker — 10 presets plus a full color wheel.
- Background preferences now persist across restarts.

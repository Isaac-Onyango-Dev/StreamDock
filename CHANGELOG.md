# Changelog

All notable changes to StreamDock are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [1.3.0] - 2026-09-07

### Fixed
- **Critical**: every download failed immediately, reported in the UI as
  "Rate limited. Waiting before retrying...". The bundled yt-dlp was
  2026.03.17 — six months stale — and YouTube rejected it partway through
  each transfer with `HTTP Error 403`; the current release completed the
  same download with byte-identical arguments. Two separate defects kept
  this invisible: `download:binaries` skipped the download whenever a
  yt-dlp binary already existed, so a once-fetched engine was reused
  forever, and the startup version check compared against a hardcoded
  `2024.01.01` floor, so a six-month-old engine passed as "OK" and the
  update banner never appeared.
- Staleness is now judged by age, not a pinned date: the engine warns
  above 30 days, warns strongly above 90, and `download:binaries`
  refreshes yt-dlp past 30 days instead of keeping whatever is on disk.
- Error classification matched bare digit substrings, so any output
  containing "429" (a fragment index, a byte count, a video ID) was
  reported as rate limiting, and "403" — a real YouTube AV1 itag — as a
  login wall. Status codes now have to appear as status codes, and the
  message is derived from the line that actually failed rather than from
  the first match anywhere in the whole stderr blob, where an incidental
  warning could win.
- Background settings appeared to do nothing. Every control was correctly
  wired and saving; the result was invisible. In solid mode a fully
  opaque overlay was painted over the chosen colour, and the chrome
  panels stayed opaque in every mode except `bing` — so solid colours
  were covered twice over and Random Photo wallpapers were hidden behind
  opaque chrome immediately after being fetched.
- The application menu was never reachable. A complete File/Edit/View/Help
  menu already existed, but the window is frameless, and Windows and Linux
  do not draw a native menu bar for a frameless window — only the
  accelerators worked.

### Added
- Failure details in the UI: a "Show details" toggle on any failed
  download reveals the engine's own output — real HTTP status and stderr,
  with paths and credentials redacted. Previously a stale-engine 403 and a
  genuine login wall produced the same one-line message, with nothing
  behind it.
- An out-of-date engine is now named as the likely cause when yt-dlp
  reports its own staleness alongside a failure, instead of that failure
  surfacing as a login wall or a rate limit.
- In-window menu bar in the custom titlebar. It renders the existing
  native menu's top-level labels and asks the main process to pop up the
  real submenus, so there is exactly one menu definition.
- Application auto-update against GitHub Releases via `electron-updater`:
  a quiet check shortly after launch and **Help -> Check for Updates**,
  both asking before downloading. `electron-builder`'s `publish` block was
  `null`, so no `latest.yml` manifest was ever generated — the release
  workflow had been trying to upload one that did not exist.
- **Help -> About StreamDock**, and GitHub repository/issue links.
- README "What's New" is now generated from `CHANGELOG.md` by
  `npm run sync:readme` and committed by CI alongside the site. It had
  drifted to v1.0.1 while the app shipped 1.2.0: the earlier version-sync
  work covered `docs/` only and never included the README.

## [1.2.0] - 2026-09-07

### Fixed
- **Critical**: packaged builds shipped with an empty `resources/binaries/`
  folder — engines showed "Not Loaded" and "Update Engines" failed for
  every user without yt-dlp/ffmpeg already on their system PATH. The
  binary-download step never actually downloaded anything and no CI
  workflow called it; this affected the just-shipped v1.1.0 release.
  `download:binaries` now really fetches and bundles yt-dlp, ffmpeg, and
  ffprobe, and runs automatically before every packaged build.
- Wallpaper preview's "Set as Background" button wasn't clickable —
  Chromium's native image-drag gesture was intercepting the click before
  it reached the handler.
- Several `bg-primary`/`border-primary`/`ring-primary`/`text-text-tertiary`
  classes in the wallpaper settings referenced color tokens that don't
  exist in this project's Tailwind config, silently rendering no color.

### Added
- App UI now shares the install site's brand (violet/pink/amber, Space
  Grotesk display type) via a single `design/tokens.json` source instead
  of two hand-maintained palettes — window/tray/installer icons, the
  titlebar wordmark, and every accent-colored control across the app.
- Live download counter on the install site (GitHub Releases-based, no
  backend) plus a README badge.

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

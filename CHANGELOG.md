# Changelog

All notable changes to StreamDock are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [1.8.0] - 2026-09-11

### Added
- **An update now shows you that it is updating.** Installing a new version used
  to give no sign at all that anything was happening: the prompt closed and a
  300 MB installer downloaded in complete silence, sometimes for several
  minutes. There is now a banner in the app with a progress bar, a percentage,
  and how much has transferred so far.
- Update progress, readiness and failure all appear in the app itself rather
  than in system dialogs, so there is one place to look.

### Changed
- **Updates never send you to GitHub any more.** A failed update used to offer a
  releases listing, which asks you to pick the right file out of a list that
  also contains files no person needs. If an update genuinely cannot install
  itself, StreamDock now opens the StreamDock download page instead, and says
  so before it does.
- The "View Release Notes" button is gone from the update prompt. It sat beside
  the install button and led out of the app on what was otherwise a working
  path.
- A failed update now explains what went wrong and offers to try again, instead
  of quietly sending you somewhere else.

### Fixed
- **Installing an update no longer risks running the installer over a live
  app.** If a download was in progress, confirming the restart raised the usual
  "downloads are active" question, and answering "keep downloading" left the
  installer running against the app it was replacing. Installing now pauses
  downloads and saves them first, so they resume after the restart.
- StreamDock no longer offers itself an older version as an update. Versions
  were compared as text rather than as version numbers, so any difference in
  either direction counted as an update being available.
- A failed update check at startup no longer has anything to say. Opening the
  app without a connection reported a failure nobody had asked for.

## [1.7.0] - 2026-09-08

### Added
- **Dubbed episodes actually download dubbed.** Sites that serve sub and dub as
  separate streams open on sub, and StreamDock took whatever the page loaded —
  so choosing "Dub" and queueing a range gave you the whole series in Japanese.
  The language you pick is now applied to every episode as its download starts.
- Sub and dub are offered as a **Language** control beside Quality, populated
  from what the source declares rather than guessed from a link.
- **Real episode counts.** A series page that states no total is now read from
  the site's own listing instead: One Piece reports 1177 episodes rather than 1.
- Episode ranges work on `anikototv.to`. The host was configured everywhere else
  in the app but was missing from the one place that recognises episode URLs, so
  pasting an episode there silently offered only that single episode.
- StreamDock now carries its MIT licence text. The project has always described
  itself as MIT without actually including the licence.

### Fixed
- **Downloads that failed with "the video host refused the download (403)" now
  work.** The media server was being told the wrong page had requested the
  video. Nothing about the site had changed and no amount of retrying would have
  helped. yt-dlp reports any such refusal as an anti-bot challenge, which is why
  this looked for a long time like something that could not be fixed.
- **An episode range no longer downloads the same episode repeatedly.** Every
  episode in a range reused the first one's video link, so a five-episode
  selection produced five progress bars, five files, and one episode.
- Downloads no longer trigger "too many requests" against themselves. A limit of
  one download at a time for these sites existed but stopped applying once a
  download started, so an entire range ran at once and the host throttled it
  part-way through.
- A stuck detection no longer freezes everything behind it. One episode failing
  to resolve left its download on "starting" forever and the rest of the queue
  waiting on it.
- A file that already exists on disk now says **Already saved** rather than
  reporting a fresh download. A 200 MB episode "finishing" in six seconds was
  reported as success.
- Detected languages are no longer guessed from link text and shown as fact. A
  guess is marked; a language the source states is not. Among other things, a
  stream served from a host with "hub" in its name was being labelled as a
  language called "Hub".
- The quality menu no longer lists "Best quality" twice.

### Changed
- **One place to make each choice.** Language, audio and subtitles could each be
  set from two or three different screens, and the copies that were always
  visible were often the ones that could not affect the download. Every choice
  now has a single home in the main row, and appears only once the source is
  known to offer it.
- Nothing is offered before you press Analyze except the URL and quality,
  because nothing else is known yet.
- The advanced section is now "Connection settings" and holds only browser
  impersonation, with a note that it is for sites that refuse a download.
- The stream dialog is now "Track details" and covers only per-track audio and
  subtitle choices, which is the one thing the main row cannot show.

## [1.6.1] - 2026-09-08

### Fixed
- **Bundled plugins now actually load.** StreamDock ships yt-dlp extractors for
  anikoto, animepahe, aniwatch and kaido, plus a PO-token provider — and none of
  them had ever been reachable in a shipped build. The plugin path resolver
  handed yt-dlp each individual package folder, when yt-dlp expects the folder
  that *holds* the packages and finds them itself. Given the wrong level it
  loaded nothing and reported it only in verbose output, so every URL relying on
  those extractors fell through to the generic one and failed as an unsupported
  link.
- The Chrome cookie-unlock plugin no longer breaks other plugins on Linux and
  macOS. It reaches Windows-only system calls as soon as it is imported, so once
  plugin loading started working it printed an import failure on every single
  download. It is now offered only on Windows, where it can run.
- **Subtitles are a choice again.** A global "embed subtitles" setting was
  applied after the per-download subtitle picker had already decided, and it
  defaulted to on — so choosing **None** still embedded a subtitle track, and
  choosing a separate file produced an embedded track *and* the file. One place
  now decides, and the setting became that picker's starting value rather than
  an override.
- The subtitle picker offers all four real behaviours: none, a separate file
  beside the video, a track inside the video, or both. Subtitles are never
  burned permanently into the picture.
- A saved subtitle preference now reaches the picker. Settings load after the
  capture screen appears, so a stored default of "None" was replaced by the
  built-in one every launch.
- **The quality menu no longer invents resolutions.** It fell back to a fixed
  1080p/720p/480p/360p list whenever it had not detected any — which was before
  you press Analyze, for every playlist, and for every episode range. You could
  pick 1080p for a source that never offered it. It now lists only what the
  source actually reports, and just "Best quality" when it reports nothing.
- Quality options read "up to 1080p", because that is what they do: a chosen
  quality is a ceiling, so each item in a playlist downloads at its own best
  within it rather than being skipped or forced.

### Changed
- The website no longer advertises automatic season and episode renaming, which
  was deliberately removed in 1.5.0, or suggest that plugins can be installed
  from inside the app. Both described behaviour the application does not have.

## [1.6.0] - 2026-09-08

### Added
- **Linux release.** StreamDock now ships an x86-64 AppImage with the same
  bundled engines the Windows build carries — yt-dlp and a full ffmpeg/ffprobe
  pair, no system Python and nothing else to install. Verified end to end on
  Ubuntu 26.04: the app boots, the bundled engines execute, and a real download
  completes and lands in the chosen folder.

### Fixed
- **Single videos no longer land in a folder called "NA".** The preview list
  auto-selects its only entry for a one-item probe, which sent yt-dlp a
  `--playlist-items 1` selection; anything in that field counted as a confirmed
  multi-item batch, so the output template took its playlist branch, found no
  playlist title to use and fell back to yt-dlp's literal `NA`. A selection
  naming exactly one item is no longer treated as a batch, wherever it came
  from — so pulling a single episode out of a series also stops creating a
  folder for it.
- **Video thumbnails are visible again.** The probe had been resolving them
  correctly all along; the renderer's Content-Security-Policy allowed images
  only from `bing.com`, so every thumbnail was blocked and drew a broken-image
  glyph. Thumbnails come from whatever site is being downloaded from, which no
  allowlist can enumerate, so `img-src` now permits any https origin. Images
  only — no plain http, and script and network policy are unchanged.
- **The Linux app icon shows the StreamDock mark instead of a generic
  placeholder.** electron-builder downsamples a single PNG into a macOS `.icns`
  or a Windows `.ico`, but for Linux it ships only the sizes it is handed — so
  the lone 1024x1024 source was installed to a hicolor directory the freedesktop
  icon index does not list (it stops at 512x512), and every desktop fell back to
  a default icon. The build now ships eight indexed sizes from 16 to 512.

## [1.5.0] - 2026-09-07

### Fixed
- **Downloads failing with "This content requires a login" when no login exists.**
  Two independent bugs, both now fixed. The classification bug: the engine
  classified a failure twice — once per stderr line while the download ran,
  with the knowledge that the URL was a resolved CDN manifest, and again at
  process exit with that context discarded. The second pass always ran last, so
  its context-free reading of a 403 replaced the accurate message. Both paths
  now go through one classifier that takes the context with it. The reporting
  bug: secret redaction ran to end of line, so
  `master.m3u8?token=…: Unable to download webpage: HTTP Error 403: Forbidden`
  reached the "Show details" panel as `master.m3u8?token=[REDACTED]` — the
  status, the reason and the whole diagnosis erased along with the token.
  Redaction is now scoped to the secret's value.
- A Cloudflare-style bot block is no longer reported as a login wall. Both are
  served as 403 and the login rule was checked first, so users were sent to
  create an account for a wall no account opens.
- Subtitle files (`.vtt`, `.en-orig.vtt`) are no longer left beside the finished
  video when subtitles were meant to be embedded. The engine passed
  `--write-subs` alongside `--embed-subs`; `--write-subs` means "keep the file",
  so yt-dlp embedded the track and kept it. Sidecar files are now written only
  when sidecars were actually asked for.
- The default subtitle language is `en` rather than `en.*`, which also matched
  YouTube's machine-translated tracks and turned one subtitle fetch into a burst
  of them — enough to earn a 429 that aborted the entire video download.
- An engine-thrown error no longer reaches the user with a leaked `Error: `
  prefix ("Error: Could not find a playable stream on this page.").
- Episode counts no longer overshoot. Probing a series generated a fixed 200
  synthetic episodes starting from whatever episode was pasted and reported
  `itemCount: 999` regardless, so a 366-episode show listed 999 — most of them
  URLs that resolve to nothing. The count now comes from the source page, and
  when a page states no count nothing is extrapolated.
- Playlists longer than the probe's 500-item scan window report their real
  length instead of exactly 500.
- A single episode no longer lands inside a show folder. The folder name was
  sent for every episode-range download including one-item ones.
- Queue rows show the real title and thumbnail again for videos started without
  pressing Analyze first. `start()` read the probe out of the React render
  closure, which is `null` until a probe has completed and re-rendered, so going
  straight to Download queued with no metadata at all — no title, no thumbnail,
  and no playlist detection either. It now ensures a probe and uses the value it
  gets back.
- The metadata probe no longer dies on YouTube. `--dump-json` was run through a
  shell string with the default 1MB stdout buffer and no `--no-playlist`, so a
  plain video overflowed the buffer (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) and any
  URL carrying `list=` made yt-dlp emit one JSON object per entry — endlessly,
  for a radio mix. It now runs via `execFile` with an argument array, a large
  buffer, and `--no-playlist`, because this probe describes one media item.
- Playlist items get thumbnails. `--flat-playlist` entries carry a `thumbnails[]`
  array and no scalar `thumbnail`, and only the scalar was ever read — so every
  playlist row fell back to the placeholder icon, in the preview list and the
  queue alike. A playlist with no poster of its own now borrows its first item's.
- A URL captured from the clipboard stays in the capture field. The watcher
  delivered it by assigning `input.value` and firing a synthetic `input` event,
  but the field is a controlled React input: that assignment also updates React's
  internal value tracker, so React saw no change, never ran its handler, and
  re-rendered the field back to empty — leaving the placeholder showing and the
  URL to be pasted by hand. It is passed as state now.

### Changed
- The queue-row label is separated from the filename hint (`displayTitle` vs
  `titleHint`). A playlist can now show its own name in the queue without that
  name being forced onto every file inside it.

- **Smart naming is abolished.** A single video is saved as `<title>.<ext>` with
  no folder; a confirmed playlist gets one folder named after the playlist,
  holding items under their real titles. The `Episode (N)` scheme and the
  `Season N` sub-folder are removed outright, not switched off — they renamed
  files away from titles the extractor already knew, leaving a finished download
  identifiable only by its position in a batch.
- **Downloads are written atomically.** Everything in progress — `.part` files,
  per-format fragments, the pre-mux stream, subtitles awaiting embedding — is
  staged in a hidden directory and only the finished file is moved into the
  download folder. Nothing half-written is ever visible to be opened, scanned by
  antivirus, or left behind by a cancel.
- The download queue shows the real title and thumbnail the probe already
  resolved, instead of a generic "Video download" label behind a camera icon.
- Long episode lists are paged 50 at a time. Paging is presentation only and
  never changes how many episodes are considered to exist.

## [1.4.0] - 2026-09-07

### Added
- **Advanced Background** panel in Settings, sitting beside Advanced yt-dlp
  Options as a matched pair and stacking on narrow windows. It is now the
  single place background is configured: ambient themes, live wallpapers
  (Bing Daily / Random Photo, preview, refresh interval) and solid colours.
- Twelve ambient background themes — Site Gradient, Glassmorphism, Cyborg,
  Hazard, Technology, Aurora, Synthwave, Nebula, Carbon, Matrix, Sunset and
  Midnight. Each preview swatch shares its CSS rule with the live background,
  so a preview cannot drift from what it applies.
- **Site Gradient is the new default background**, transcribed from the install
  site's live CSS rather than approximated: base `#0A0716`, violet/pink/amber
  colour blobs in the site's own positions, and its 28px violet dot grid.

### Changed
- A saved background preference is never overwritten by the new default. The
  gradient is adopted only for fresh installs, for settings files that predate
  the option, and for the one case that is provably untouched — the old default
  mode paired with the old default colour, a combination the colour picker
  never offered. Any other stored mode or colour is left exactly as it was.

### Fixed
- The title bar showed "StreamDock" twice: the gradient wordmark, then a plain
  text duplicate. The duplicate was the native menu's app-name entry, a macOS
  convention that the custom titlebar was rendering as an ordinary menu label
  on Windows and Linux. It is now macOS-only; every item in it already existed
  under File and Help.
- The sidebar's top icon was the same download arrow as the Downloads tab
  directly beneath it, in an accent-tinted box that also read as an active-tab
  highlight — the app logo and a nav button were indistinguishable. It is now
  the real StreamDock mark from `assets/icon.svg`, and the tinted background is
  once again unique to the selected tab.

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

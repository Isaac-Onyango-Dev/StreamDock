# StreamDock — Project Notes

Electron + React + TypeScript desktop app for video downloading and live-stream
capture, built on yt-dlp. Repo: https://github.com/Isaac-Onyango-Dev/StreamDock.
Owner: Isaac. Local path: `D:\PROJECTS\StreamDock`.

This file exists so a future session (Claude or otherwise) can pick up context
fast without re-deriving it. Update it as work continues — don't let it go stale.

## Architecture, quickly

- `electron/main.ts` — main process entry point: window lifecycle, IPC wiring,
  tray, crash reporter, boot sequence.
- `electron/download-engine.ts` (~50KB) — the core `DownloadEngine` class:
  spawns yt-dlp, parses progress, manages the queue/state machine
  (queued/running/paused/completed/failed/cancelled/retrying/scheduled).
- `electron/url-router.ts` — authoritative URL classification (video vs stream
  mode, host routing). Reads `electron/host-config.json` at runtime with a
  hardcoded fallback if that file is missing/corrupt.
- `electron/playlist-inspector.ts` — probes a URL to determine what kind of
  content it is (single video / playlist / episode-range / manifest-probe) and
  returns preview data for the UI.
- `electron/manifest-extractor.ts` (~39KB) — hidden-`BrowserWindow`-based
  manifest discovery (HLS/.m3u8, DASH/.mpd) for sites yt-dlp can't handle
  directly.
- `electron/stream-options-probe.ts` — discovers dub/sub/server language
  options for anime/streaming sites via DOM interaction in a hidden window.
- `electron/smart-naming.ts` — pure-function yt-dlp `-o` output-template
  builder. Fully unit-tested; no side effects.
- `electron/wallpaper-manager.ts` + `electron/source-status.ts` — cosmetic
  background wallpaper rotation, and a best-effort advisory lookup against a
  community site-status index. Both are deliberately isolated so failures in
  either can never affect core download functionality.
- `client/src/` — React 18 + TypeScript + Vite + Tailwind v3 renderer.
  `App.tsx` is the shell; `views/CaptureView`, `views/TransferView`,
  `views/SettingsView` are the three tabs.
- Build: esbuild bundles `electron/main.ts`/`preload.ts` → `dist-electron/*.cjs`;
  Vite builds the renderer → `dist/client/`; electron-builder packages.
- Tests: Vitest (`*.test.ts`/`*.test.tsx`, happy-dom) + Playwright e2e
  (`tests/e2e/`). The e2e specs load the renderer over HTTP and assert on the
  DOM, so they are browser tests: no Electron, no binaries, no display needed.
  Session 7 corrected a long-standing claim to the contrary.

Key scripts: `npm run typecheck` (two tsconfig projects — renderer and
electron, run both), `npm run lint` (`eslint .` — flat config,
`eslint.config.js`, zero-warning gate in CI, and it covers `scripts/` since
session 16), `npm test` (Vitest), `npm run build:app` (production build without
packaging), `npm run verify:engine` (a pure static/unit check — no binaries, no
network), `npx playwright test` (e2e).

**Diagnosing a real user-reported failure? Start here:**
`%APPDATA%/streamdock/streamdock.log` is `electron-log`'s output from Isaac's
actual runs — full yt-dlp spawn command lines, verbatim stderr, timestamps.
`logs/main.log` beside it only records version banners.

## Where things stand (as of this session)

Thirteen work sessions have happened against this repo so far.

**Correcting a claim this file carried for three sessions:** sessions 5 and 6
were *not* unpushed. Verified in session 9 — `HEAD == origin/main` and
`origin/main`'s package.json is at 1.4.0, so every commit through session 7 is
on the remote. What was missing was never the commits: it was the **tags**,
which stopped at v1.2.0. That distinction is the whole of the release drift, and
believing "unpushed" hid it.

### Session 1 — general bug-fix and optimization pass

Went in cold ("fix and optimize this video downloader"), found and fixed 15
issues via inspection + a from-scratch verification pipeline (this repo had
no CI running locally before this). Highlights, most important first:

- **The entire Vitest suite was silently collecting 0 tests** — `tests/setup.ts`
  did `global.crypto = {...} as any`, which throws on Node 19+ (`crypto` is a
  non-configurable getter). Fixed via `vi.stubGlobal`. This is why the bugs
  below existed undetected — there was no working safety net.
- `format-detector.ts`: fMP4 URLs (e.g. `/fragment.mp4`) were misclassified as
  plain `mp4`, causing the wrong download strategy (`--concurrent-fragments 4`
  applied to a fragmented stream). YouTube Live's specific message was
  unreachable, shadowed by the generic live-host check running first.
- `smart-naming.ts`: `sanitizeName()` didn't collapse runs of illegal
  characters (one underscore per char, not per run); season template leaked
  into raw manifest/CDN downloads where it can never resolve.
- `download-engine.ts`: Windows `.part` cleanup was broken by a
  `lastIndexOf('/') || lastIndexOf('\\')` bug (`-1` is truthy in JS, so the
  backslash branch never ran on Windows); manifest-retry could produce files
  literally named `Extracting stream manifest….mp4`.
- `wallpaper-manager.ts`: unbounded disk leak (old picsum wallpapers never
  cleaned up); "most recent wallpaper" picked via `readdir()` order instead of
  actual mtime.
- Plus: a real TS compile error and a masked config-load fallback bug in
  `url-router.ts`; several forbidden `require()` calls, dead functions, `any`
  types, and empty catch blocks cleaned up for the ESLint zero-warning gate
  (went from 42 problems to 0).

Ended at: typecheck clean, ESLint 0/0, Vitest 59/59, production build verified.

### Session 2 — triage against a `Task.md` spec (6 numbered priorities)

Isaac supplied a detailed task spec (uploaded as `Task.md`) claiming the app
was "bricked" by a wallpaper crash and listing 5 more priorities (playlist UI,
dub/sub labeling, exact naming format, UI/UX overhaul, reference-site misuse).
**Important discipline applied here, worth repeating in future sessions:**
every claim was verified against the actual current code before acting on it,
rather than assumed true because it was written down. Three of six priorities
didn't match reality on inspection; three were real and got fixed.

**Confirmed real and fixed:**

- **Reference-site misuse (`everythingmoe.com`)** — it was correctly listed as
  a reference-only host in `url-router.ts`'s `REFERENCE_HOSTS`, but *also*
  listed in `manifestProbeHosts`/`animeHosts` (which drive real extraction
  logic), so `playlist-inspector.ts` and `download-engine.ts` would still
  attempt to treat it as real content — `inspectUrl()`'s reference check ran
  *after* episode-pattern detection, so episode-shaped URLs slipped past it
  entirely, and `download-engine.ts`'s `start()` had no guard at all. Fixed on
  all four fronts (see commit `a46c051`), added a hard guard in `start()`, and
  removed it from the functional host lists in both `url-router.ts` and
  `host-config.json`. Also built `electron/source-status.ts` — a best-effort,
  advisory-only, fail-silent lookup against the reference index's "Graveyard"
  section, wired via `IPC.SOURCE_STATUS_CHECK` and surfaced as a dismissible
  toast in `CaptureView` (never blocking). Explicitly flagged as
  lower-confidence than the rest of this work: built from a paraphrased view
  of the reference site's content, not its raw markup.
- **Dub/sub language labeling** — three of four `StreamOption`-construction
  paths in `stream-options-probe.ts` skipped language detection and fell back
  to bare "Stream 2"/"Stream 3" labels. Added an independent `language` field
  (always populated, explicit `'Unknown'` fallback, never blank) via a shared
  `classifyLanguage()` helper, applied at every construction site, rendered as
  its own badge in `MediaLanguageSelectionModal.tsx`.
- **Exact naming spec** — `buildOutputTemplate()` used yt-dlp's own
  `%(playlist_index)03d-title` / zero-padded `Season %02d` templates instead
  of the literal required spec (`Episode (1).format`, `Season 1` unpadded, no
  folder at all for a single video). Rewrote to match exactly; deliberately
  uses `playlist_index` (not `episode_number`) as the counter since it's
  guaranteed unique/sequential per batch, which also sidesteps
  duplicate-episode-number metadata bugs some extractors have. Added
  `--no-overwrites` to the yt-dlp invocation so re-downloads skip rather than
  silently clobber. 15 tests cover the new template logic
  (`smart-naming.test.ts`).

**Investigated, did NOT confirm, but the underlying claim contradicted actual
code — flagged honestly rather than faked a fix:**

- **"Wallpaper crash bricks the app"** — traced the full chain
  (`wallpaper-manager.ts` init/fetch/rotate, IPC, `App.tsx`, CSS) and found it
  already fully async/non-blocking/error-handled. Isaac confirmed the crash is
  still happening on his machine when asked directly, but this session has no
  way to run his actual Windows Electron GUI process to reproduce it (only
  file/shell access to the repo, no live app). **Did find and fix a real,
  independent structural defect**: `app.whenReady()`'s boot sequence created
  the wallpaper cache directory and registered the `wallpaper://` protocol
  handler *before* `createWindow()`, with no try/catch — any throw there
  (locked path, disk, AV interference) would silently kill the entire async
  boot callback via an unhandled promise rejection, so the window would never
  appear at all. Reordered so `createWindow()`/`setupIpc()` run first and
  unconditionally, and isolated the wallpaper setup in its own try/catch
  afterward (commit `2be9f8e`). **This is a real fix but unconfirmed as THE
  root cause** — if the crash persists, the next session needs an actual
  repro: does a window ever appear at all, any error dialog, and ideally a
  `crash-*.txt` from the app's userData folder (written by
  `electron/crash-reporter.ts` on any uncaught exception).
- **"UI/UX overhaul needed — inconsistent sizing, not responsive"** — audited
  the window config (no `resizable: false`, no max-size lock), the shell
  layout (`AppChrome/index.tsx` — proper `flex`/`min-w-0`/`min-h-0` throughout,
  CSS-variable-driven sizing, correct frameless-window drag regions), the
  design-token system (`tokens.css` already has a full 10-step spacing scale
  and radius scale), and grepped for fixed-pixel-width traps across all of
  `client/src` (found none of consequence — a handful of small,
  intentionally-fixed icon/toggle-sized elements, nothing layout-breaking).
  Genuinely didn't find what the spec described. **If this is still visibly
  wrong when the app is actually run, the fastest path forward is a
  screenshot** — static code reading can miss things that only show up
  rendered.
- **"Playlist selection UI incomplete/broken"** — read `CaptureView/index.tsx`'s
  selection flow (`all`/`first`/`range`/`schedule` modes, per-item checkboxes,
  distinct handling for YouTube playlists vs. YouTube Music vs. episode-range)
  and it looks fully built. Not exercised live, so treat as "probably fine,
  unverified" rather than "confirmed fine."

## Known environment gaps (not caused by any fix above)

- **`npm install` on Isaac's actual machine (via the device bridge) times out
  repeatedly**, with signs of AV/disk interference (an `ENOTEMPTY` rename
  conflict appeared on a retry). Not related to any dependency change — no
  `package.json` edits have been made by either session. If a future session
  hits this, don't retry the same non-idempotent command blindly; consider
  asking Isaac to try it directly in his own terminal, or exclude
  `node_modules` from real-time AV scanning.
- ~~**`npm run verify:engine` and the Playwright e2e suite have never been
  run** — e2e needs real yt-dlp/ffmpeg binaries and a display.~~
  **This was wrong, and it misled sessions 3-6. Corrected in session 7:**
  neither job ever needed binaries or a display. `verify:engine` is a pure
  static/unit check that crashed on an `import { app } from 'electron'` reached
  through `url-router`, and the e2e specs are headless-Chromium renderer tests
  that were failing on an invalid Playwright `channel: 'electron'` project plus
  an ambiguous selector. Both now pass. See session 7.
- Both sessions' verification (typecheck/lint/test/build all green) ran in an
  isolated sandbox copy of the exact same source tree/lockfile as
  `D:\PROJECTS\StreamDock`, **not** in Isaac's live environment directly — the
  npm install issue above is why. The sandbox and the live repo are kept in
  sync file-by-file after each verified change, but a full `npm install`
  hasn't successfully completed on the live machine within either session.

### Session 3 — install site redesign, version sync, and going live

First session to actually push to the real repo (both prior sessions left their
work uncommitted locally — see the git log dates vs. the session narrative
above). Two commits landed the backlog: `228aed9` (sessions 1+2's fix pass,
committed as-is after fixing one regression it introduced — an unused
`onNotice` prop on `CaptureView` that broke typecheck) and `97429a9` (this
session's site work), followed by `148ee8f` fixing a reliability bug found
during live verification.

**Version bumped 1.0.2 → 1.1.0** (minor: dub/sub language labeling and the
source-status advisory are new functionality, not just fixes) and actually
tagged/pushed/released — `v1.1.0` is live with real Windows assets attached
for the first time (the `v1.0.2` release predates `release.yml` by 9 days and
shipped with zero assets; nobody had noticed).

**Site (`docs/`) fully rebuilt**, not just re-skinned:
- New brand identity from scratch (nothing to reuse before this): violet/pink/
  amber gradient (`--violet #8B5CF6`, `--pink #EC4899`, `--amber #FBBF24`) on
  a near-black base, Space Grotesk display + Inter body. Old site was
  teal/sky on near-black — this is a deliberate, complete departure, not a
  tweak.
- `docs/index.html` is now a **generated file** — `docs/index.template.html`
  is the hand-edited source, `scripts/build-site.ts` (`npm run build:site`)
  injects the version and the latest `CHANGELOG.md` entries into it.
- **Version sync root cause**: nothing injected the version anywhere before;
  it was hand-edited in `docs/index.html` and drifted. Fixed two ways at
  once: (1) electron-builder now emits stable per-platform filenames
  (`StreamDock-Setup-Windows.exe` etc., set via `artifactName` in
  `package.json`'s `build` block) so download buttons link straight to
  `releases/latest/download/<name>` — GitHub resolves that to whatever's
  current with **zero API calls**, so there's nothing to keep in sync for
  the download link specifically; (2) `.github/workflows/deploy-site.yml`
  runs `build:site` and commits the regenerated `docs/index.html` back to
  `main` (Pages already serves `main`/`docs`, so this needed no Pages
  settings change).
- **Found and fixed a real reliability bug the hard way**: `deploy-site.yml`
  originally triggered on `release: published`, but `release.yml` creates
  its release with the default `GITHUB_TOKEN`, and GitHub Actions blocks
  `GITHUB_TOKEN`-driven events from triggering other workflows
  (anti-recursion protection) — so that trigger would have silently never
  fired on a real tagged release, reintroducing the exact staleness bug this
  work was meant to close. Switched to `workflow_run` reacting to
  `Build & Release` completing, which isn't subject to that restriction.
  Verified by manually dispatching the fixed workflow after pushing it —
  confirmed green. **Lesson for future workflow-chaining work in this repo**:
  a workflow triggered by another workflow's `GITHUB_TOKEN`-authored event
  will not fire — use `workflow_run` instead, and check it actually fired
  before trusting it.
- Also caught and fixed mid-build: several platform/feature glyphs (🪟 🐧 📡
  etc.) were silently falling back to missing-glyph boxes on this Windows
  machine's emoji font. Found by actually rendering the page in a browser,
  not by reading the HTML — replaced the whole icon set with hand-authored
  inline SVGs matching the nav/download glyph style already in use.
- Added `docs/404.html`, `robots.txt`, `sitemap.xml`, `.nojekyll`, and an
  SVG OG/Twitter card image (`docs/assets/og-image.svg` — SVG, not PNG;
  Facebook/LinkedIn preview fidelity for SVG og:image is inconsistent, flagged
  as a known limitation rather than silently assumed to work everywhere).

**Verification**: live site confirmed showing v1.1.0, direct Windows download
link confirmed resolving through GitHub's redirect chain to a real ~102MB
`.exe` (200, `application/octet-stream`). Responsive check done via a fixed-
width iframe harness (`resize_window` wasn't actually reaching the real
viewport in this sandboxed environment — `window.innerWidth` stayed pinned to
the physical display size no matter what was requested) at 390/820/1440px;
nav collapse, fluid type, and OS-detect platform-pill highlighting all
confirmed working.

**Known gap, not touched this session**: `ci.yml`'s `Verify Engine` and
`E2E Tests` jobs failed on the first real run in GitHub Actions (this is the
first time `ci.yml` ever actually ran there — it was added uncommitted in the
prior sessions' fix pass). This matches what CLAUDE.md already flagged before
this session started: `verify:engine` and Playwright e2e need real yt-dlp/
ffmpeg binaries and a display that the hosted `ubuntu-latest` runner doesn't
have. Not a regression from this session's changes (nothing touched those
code paths) — needs a follow-up session to either provision those binaries
in CI or scope those jobs down to what a hosted runner can actually do.

**SSH access**: this session generated a passphrase-less ed25519 key at
`C:\Users\ISAAC\.ssh\id_ed25519` (Isaac added the public key to GitHub) so
pushes could happen non-interactively. Worth knowing if a future session
finds it already there.

### Session 4 — brand match, download counter, and a critical binary-bundling bug

Landed as 5 separate commits (`a0d2f96` brand tokens, `ca633fd` download
counter, `1b5a965` engine-binaries fix, `c71928b` wallpaper button fix,
`9135513` version bump), pushed and released as **v1.2.0**.

**The most important finding this session**: v1.1.0 — the release from
session 3, live for a few hours — was **actually broken for every user**.
`binaries/` is gitignored, and `scripts/download-binaries.ts` had never
actually downloaded anything; it only printed instructions. No CI workflow
called it either, so `resources/binaries/` was silently empty in every
packaged build. The evidence was in plain sight: v1.1.0's installer was
~102MB; the real yt-dlp+ffmpeg+ffprobe alone are ~420MB. Rewrote the script
to really fetch and extract them (yt-dlp from its own releases, ffmpeg from
BtbN's GitHub-hosted build), wired it into `release.yml` and `ci.yml`, and
verified end-to-end against a scratch directory — not the local `binaries/`,
which already had real files from some earlier manual setup and would have
masked the bug completely. v1.2.0's installer is ~287MB, confirming the fix.
Also found and fixed a second bug *while fixing the first*: the extraction
step's bare `tar` resolved to Git for Windows' GNU tar (present earlier on
PATH than System32 in this environment), which misparses a `C:\...` argument
as a remote host spec — fixed by calling System32's bsdtar explicitly.

**Brand match**: `design/tokens.json` is now the single source of truth for
the violet/pink/amber palette, generated into `client/src/styles/brand.css`
(overrides the app's accent color, previously blue) and read directly by
`scripts/build-site.ts` for the site — no more hand-typing the same hex
values in two places. Regenerated `assets/icon.{svg,png,ico}` and
`logo.svg` in place (no old-branding files left behind).

**Download counter**: Tier 1 only (GitHub Releases-based), exactly as
scoped — deliberately did *not* build the elaborate `client/`+`server/`+
`VITE_TARGET` web-app mirror that `D:\tasks\streamdock-website-prompt.md`
originally described (that prompt predates the actual `docs/`-based static
site built in session 3; task2.md's own instructions explicitly scoped
it down to fit reality, and following the old prompt literally would have
built a second, redundant site).

**Wallpaper button**: best-available fix (Chromium's native image-drag
gesture intercepting the click — `draggable={false}` fixes it), but **not
verified by an actual click** — this session only has Chrome tab
automation, not desktop automation for the real Electron window. If it's
still broken, that's the next thing to check, ideally with a screen
recording or a description of exactly what happens when clicked.

**Known limitation carried forward again**: `ci.yml`'s `Verify Engine` and
`E2E Tests` jobs still fail (same pre-existing gap noted in session 3 —
hosted runner has no real yt-dlp/ffmpeg/display). Untouched this session,
unrelated to anything above.

### Session 5 — the "Rate limited" download regression, menu, README sync

Landed as one commit (`1668e86`), version bumped 1.2.0 -> 1.3.0. **Not pushed
or released** — left for Isaac to review first.

**P0 — downloads completely broken. Root cause found by reproduction, not
inspection.** The reported symptom ("Rate limited. Waiting before retrying...",
stuck at 0%) was a mislabel. Running the engine's exact argument set by hand
against a plain YouTube URL reproduced a real failure: the bundled yt-dlp
(2026.03.17) got `HTTP Error 403` ~30% into the transfer, while the current
release (2026.08.19) completed the same download with byte-identical arguments.
yt-dlp itself was printing "your version is older than 90 days" into stderr the
whole time. **The technique that settled it: run the exact spawn arguments the
engine builds, standalone, and diff old binary vs new. Don't reason about
whether an engine is "current enough" — test it.**

Three contributing defects, all fixed:
- `scripts/download-binaries.ts` returned early whenever `yt-dlp.exe` existed,
  so a once-fetched engine was reused forever. CI was unaffected (clean runner
  each build) which is exactly why it survived — the bug only bit dev machines
  and anyone who had installed a while ago. Now refreshes past 30 days.
- `version-checker.ts` had `MIN_VERSION = '2024.01.01'`, a hardcoded floor. A
  six-month-stale binary compared as "newer than the minimum" and reported OK,
  so the (already-built, already-wired) update banner never fired. Replaced
  with age derived from the release date encoded in the version string — warn
  >30 days, strongly >90. Self-maintaining; no constant to bump.
- `error-translator.ts` classified with bare substring tests over the *whole*
  stderr blob. `includes('429')` matches a fragment index or byte count;
  `includes('403')` matches YouTube's AV1 itag 403; `includes('geo')` matches
  almost anything. First match anywhere won, regardless of which line it came
  from. Now: status codes must appear as status codes (`hasHttpStatus`), and
  classification runs on `pickFatalLine()` — yt-dlp's last `ERROR:` line —
  instead of the blob, so a warning above it can't hijack the message.

Also added `errorDetail` on `DownloadRecord`, surfaced as a "Show details"
toggle on failed rows (redacted engine stderr). This is the durable fix: the
friendly one-liner made a stale-engine 403 and a real login wall
indistinguishable in the UI.

**P1 — menu + auto-update.** `buildAppMenu()` with a full File/Edit/View/Help
template **already existed and had for a long time**; the window is
`frame: false`, and Windows/Linux draw no native menu bar for a frameless
window, so only the accelerators ever worked. Fixed with
`client/src/components/AppChrome/MenuBar.tsx`: renders only the top-level
labels in the custom titlebar and calls `IPC.MENU_POPUP` so the main process
pops the *real* submenu — one menu definition, not two. Added
`electron/app-updater.ts` (electron-updater, `autoDownload = false`, launch
check + Help -> Check for Updates). **`electron-builder`'s `publish` was
`null`**, so it never generated `latest.yml` — `release.yml` had been trying to
upload one that didn't exist, with `fail_on_unmatched_files: false` hiding it.
`electron-updater` is deliberately `external` in esbuild (like `electron-log`)
because it resolves parts of itself dynamically.

**P2 — README drift.** Diagnosed rather than patched: session 3's version-sync
covered `docs/` only; the README was never in any automation and had been
hand-edited since v1.0.1. Extracted the changelog parser to
`scripts/lib/changelog.ts`, added `scripts/sync-readme.ts` + `npm run
sync:docs`, and `deploy-site.yml` now commits `README.md` alongside
`docs/index.html`.

**P3 — background controls.** Not a click bug at all. Every control was wired
correctly and saving correctly; the *result* was invisible, in two places at
once: `.app-background::after` painted a fully-opaque-at-both-ends gradient
over the chosen colour in solid mode, and `.bg-chrome-*` panels stayed fully
opaque in every mode except `bing` — so solid colours were covered twice, and
`picsum` wallpapers were hidden behind opaque chrome immediately after being
fetched. Session 4's `draggable={false}` fix was real but addressed a
different, smaller thing. **Lesson: "button doesn't work" in this app has twice
now been a render-layer problem, not a handler problem — check what paints on
top before touching the handler.**

**Verification**: typecheck (both projects), ESLint 0/0, 97 Vitest tests
(19 new, built from stderr captured verbatim from the real failure), production
build, app boots clean (`[startup] yt-dlp version check: 2026.08.19`), and two
real end-to-end downloads through the engine's exact argument set — YouTube
(243MB) and archive.org (332MB), both exit 0.

**Still unverified — needs Isaac at the keyboard** (this session has Chrome
automation only, no desktop automation for the Electron window): the menu bar
actually popping submenus on click, background controls visibly applying, and
a download run through the app's own UI rather than the engine directly.
Auto-update cannot be verified until a release *after* this one exists, since
v1.2.0 and earlier shipped without `latest.yml`.

### Session 6 — UI polish: title bar, sidebar mark, Advanced Background

One commit, version 1.3.0 -> 1.4.0. Driven by `D:\tasks\task.md` plus three
screenshots. **Not pushed or released** (1.3.0 from session 5 is also still
unpushed).

- **Duplicate "StreamDock" in the title bar** was the *native menu's* app-name
  entry, not a stray `<span>`. `buildAppMenu()` put a `{ label: 'StreamDock' }`
  top-level menu on every platform (a macOS convention), and session 5's
  in-window `MenuBar` faithfully rendered it as plain text right next to the
  gradient wordmark. Now macOS-only; its three items already existed under File
  and Help, so nothing was lost but a redundant Ctrl+O alias for Ctrl+D.
  `MenuBar` also takes `enabled` and is off on macOS, where the system menu bar
  draws the real thing. Verified at runtime via a new startup log line:
  `[menu] Top-level menus: File, Edit, View, Help`.
- **Sidebar top icon** was literally `<Download />` — the same component the
  Downloads tab uses a few pixels below — inside an `bg-accent/15` box that also
  looked like the active-tab highlight. Replaced with
  `client/src/components/BrandMark.tsx`, an inline transcription of
  `assets/icon.svg` (the canonical mark shared with the installer icon and the
  site nav), and the tinted wrapper removed so accent-muted stays unique to the
  selected tab.
- **Advanced Background panel.** `BackgroundSettings` was `md:col-span-2` (full
  width) and rendered after `YtDlpSettings`, leaving the empty space beside
  yt-dlp visible in the screenshot. Swapped the order and dropped the span so
  the two "advanced" cards share the last grid row; restyled the card to match
  `YtDlpSettings` exactly (heading + description + `border-t` divider). All
  background controls were *moved* here, not duplicated — there is no second
  background surface.
- **Twelve ambient themes** in `client/src/styles/backgrounds.css`, listed for
  the UI in `client/src/lib/backgroundThemes.ts`. Each theme declares only
  `--bg-base` / `--bg-image` / `--bg-size`, consumed by both `.app-background`
  and the `.theme-swatch` previews — **the swatch is the theme, so a preview
  cannot drift from what it applies.** Every gradient is percentage-positioned
  so one declaration reads correctly at 26px and at 1440px.
- **Site gradient is the new default.** Values transcribed from the live site's
  CSS (`curl`'d and diffed against `docs/index.template.html`, not eyeballed):
  base `#0A0716`, the three blob positions/colours/opacities, and the 28px
  `rgba(167,139,250,.08)` dot grid. Modelled as radial-gradients rather than
  blurred elements so there is no `filter` repaint on resize.
- **Upgrade safety.** `updateSettings` persists the whole merged object, so
  changing *any* unrelated setting had already written `backgroundMode: 'solid'`
  to disk — a stored 'solid' is therefore not evidence the user chose it, and
  there is no history to recover. The one provably-untouched state is the old
  default mode paired with the old default colour `#0b1014`, which the picker
  never offered as a preset, so it cannot realistically have been chosen. Only
  that pair migrates; anything else is left alone. The migration is applied on
  *read*, never written back. 11 tests in `electron/persistence.test.ts`.

**Two new `BackgroundMode` values**: `'gradient'` (the site gradient — its own
mode because it is the default) and `'theme'` (+ `backgroundTheme` naming one of
the others). `App.tsx` only emits `data-bg-theme` when the mode is `'theme'`, so
a stale stored theme id can't style a background the user has switched away
from — verified in the browser.

**Verification**: typecheck, ESLint 0/0, 108 tests, production build. Visually
verified in Chrome against the dev server with the preload bridge stubbed:
titlebar (single wordmark + File/Edit/View/Help), sidebar mark, the two advanced
panels side by side, all 12 theme swatches, and the full click -> persisted
setting -> computed CSS chain for gradient, theme and solid modes.

### Session 7 — CI actually made green (and a misdiagnosis corrected)

Isaac supplied the real Actions logs (`D:\logs_92478332964`) for run
`d8931ba`. **The two long-standing CI failures had nothing to do with missing
binaries or a missing display** — the explanation this file had carried since
session 3, repeated without anyone testing it. Both were ordinary bugs.

**`Verify Engine` — three separate rots, in a script that had never once run.**
1. `scripts/verify-engine.ts` imported `../electron/url-router`, whose top-level
   `import { app } from 'electron'` resolves to the npm shim under plain Node
   (tsx), a module with no named exports:
   `SyntaxError: The requested module 'electron' does not provide an export
   named 'app'`. It died before the first assertion, always, everywhere.
2. Its naming assertions encoded the **pre-session-2** templates
   (`%(playlist_index)03d-%(title)`, zero-padded `Season %02d`). Session 2
   rewrote `buildOutputTemplate` to the literal spec and updated
   `smart-naming.test.ts`, but not this script — nobody could run it to notice.
3. Its route assertions demanded `everythingmoe.com` be in `MANIFEST_PROBE_HOSTS`
   and `ANIME_HOSTS` — i.e. **it asserted the exact bug session 2 fixed**, and
   directly contradicted the regression test in `url-router.test.ts`.

   Fixed by reading `electron/host-config.json` directly (no electron import,
   and a better check for a static script: it verifies the shipped config, not
   the router's hardcoded fallback), updating the naming assertions, and
   inverting the everythingmoe checks into a guard that the config never
   reintroduces it into a functional host list. **35 checks now pass.**

**`E2E Tests` — two bugs, neither environmental.**
1. `playwright.config.ts` declared a project with `channel: 'electron'`.
   That is not a Playwright channel (`channel` picks a Chromium build; Electron
   uses the separate `_electron.launch()` API), so all four of its tests failed
   with `Unsupported chromium channel "electron"`. Removed — the specs load the
   renderer over HTTP and assert on the DOM, so they are browser tests, and the
   fake project was hiding the fact that **real Electron e2e coverage does not
   exist**. Adding it means `_electron.launch()` in its own spec file.
2. `text=Save location` matched both the card heading and the Settings page
   description ("Save location, engine binaries, and preferences.") — a strict
   mode violation, not a missing element. Now role-based; `text=Engines` had the
   same latent ambiguity with the "Engines ready" badge and was fixed too.
   `webServer` now runs Vite alone rather than `npm run dev`, which also spawned
   an Electron process these tests never talk to. **4/4 pass locally.**

**Consequence worth knowing**: `build-windows/macos/linux` list
`verify-engine` in their `needs`, so they had been silently **skipped** on every
push to main for as long as that job was red. Fixing it makes them run. Since
session 5 added a `publish` block to package.json, electron-builder's default
`onTagOrDraft` policy would have made a tag build try to publish on its own and
collide with `release.yml`'s upload — so every `npm run build` in CI and in
release.yml now passes `--publish never`. That still emits the `latest.yml`
update manifest (it comes from the publish *config*, not the publish *action*);
only the upload is suppressed, leaving `release.yml` as the single publisher.

**Then the macOS build failed — a job that had never run before.** With
verify-engine green, `Build Windows` and `Build Linux` passed on the first
attempt, but `Build macOS` died after 17s: far too fast to have packaged
anything. Cause: `assets/icon.png` was 256x256, under the 512x512 minimum
electron-builder enforces converting an icon to `.icns`. Windows uses
`icon.ico` and Linux is lenient, so only macOS cared, and nothing had ever
built macOS. Added `scripts/generate-icons.ts` (`npm run icons:build`), which
rasterizes `assets/icon.svg` — the canonical mark — to a 1024x1024 PNG via
Playwright and refuses to write anything under 512, so this cannot silently
recur. Manual, not part of `npm run build`: a normal build needs no browser.

**Then Windows broke — a genuine upstream change, caught live.** After macOS
went green, `Build Windows` started failing at "Download engine binaries" in
3-4 seconds on commits whose diffs never touched that script, while an earlier
run of the same code had passed. Cause: `scripts/download-binaries.ts` fetched
ffmpeg from `releases/latest/download/ffmpeg-master-latest-win64-gpl.zip`.
`releases/latest/` resolves to whatever GitHub currently calls the newest
release, and **BtbN publishes dated autobuilds** (`autobuild-2026-09-07-15-39`,
published 15:40 UTC that day) whose assets use versioned names like
`ffmpeg-N-126455-gecc7eb519e-win64-gpl.zip`. The instant that autobuild
published, the stable `ffmpeg-master-latest-*` name 404'd. The run at 15:17
succeeded; every run after 15:40 failed.

Fixed by pinning to BtbN's **`latest` tag** —
`releases/download/latest/ffmpeg-master-latest-win64-gpl.zip` — the rolling
release they maintain precisely to carry the stable filenames.
`releases/latest/` and the `latest` tag are different things; do not conflate
them. **This was release-blocking, not just CI noise**: `release.yml` runs the
same step, so tagging in that window would have produced a failed release.

Downloads also gained retry with backoff (4 attempts, 2s/4s/8s) since a single
429/5xx previously aborted a whole packaged build. A 404 deliberately does *not*
retry — and that fast-fail is what made this diagnosable, since a 4-second
failure obviously was not a network problem.

**Lesson**: a red CI job that everyone has agreed is "environmental" is worth
running locally once. Three sessions inherited that assumption; the actual
failure was a stale import and a typo-grade config error. And a job that is
skipped is not a job that passes — the build jobs were green-by-absence for
months because their `needs` was red.

### Session 8 — the "login required" mislabel, naming abolished, atomic writes

Version 1.4.0 -> 1.5.0. **Not pushed** (1.3.0 and 1.4.0 are also still unpushed).
Driven by a six-priority round-4 spec. As in session 2, several of the spec's
stated root causes did not survive contact with the code — the real causes were
found by reproduction and are recorded below, because they are more useful than
the reports were.

**The single most valuable artefact this session: `%APPDATA%/streamdock/streamdock.log`.**
It is `electron-log`'s real output from Isaac's own runs, with full spawn
command lines, verbatim yt-dlp stderr, and timestamps. It answered in one grep
what would otherwise have been guesswork, and it is the first place a future
session should look. `logs/main.log` beside it only records version banners.

**P0 — "This content requires a login" on downloads that used to work.**
Two independent bugs, plus a site-side change that is not a StreamDock bug at all.

1. *The mislabel, proven from the log rather than inferred.* At 18:14:55.974 the
   engine logged `CDN access denied — likely a session/token expiry`; 0.5s later
   at 18:14:56.441 it logged `failed: This content requires a login`. Two
   classifiers, and the second one won. `consume()` classified each stderr line
   with `task.manifestAttempted` in hand; `close()` then called `fail()`, which
   re-ran a **context-free** `toUserError()` over the same stderr — and `close()`
   deletes the task from `this.tasks` *before* calling `fail()`, so the context
   could not be recovered even in principle. There is now one
   `classifyEngineFailure(error, context)`, and `close()` hands the context in.
2. *The details panel was erasing the evidence.* `sanitizeRaw`'s
   `token\s*[=:][^\n]*` ran to end of line, so
   `master.m3u8?token=…: Unable to download webpage: HTTP Error 403: Forbidden`
   became `master.m3u8?token=[REDACTED]`. The status, the reason phrase and the
   whole diagnosis were redacted along with the secret — on exactly the failures
   where that panel exists to help. Redaction is value-scoped now; header-form
   `Cookie:` lines are handled separately and still run to end of line.
3. *The actual download failure is not StreamDock's to fix.* `cdn.imgnex.top`
   (anikoto's CDN) sits behind Cloudflare bot management. Verified: the CDN root
   and the manifest return the identical Cloudflare interstitial
   (`Server: cloudflare`, `CF-RAY`, "Sorry, you have been blocked") **with and
   without a token**, so the token is never even evaluated; and every one of six
   `--impersonate` targets (chrome, chrome-136:macos-15, edge-101:windows-10,
   firefox-135, safari-18.0, chrome-131:android-14) got the same 403. The token
   is also not expiring: it encodes an expiry ~90s out and the failure happened
   ~1s after minting. **The old "The link may have expired — try again" message
   was itself a wrong guess**, which is why the new message does not claim it.
   The hidden BrowserWindow passes Cloudflare because it is a real browser; it
   captures no cookies on that path, so there is nothing to hand yt-dlp.
   Downloading it would mean fetching HLS through the Electron session — a real
   feature, deliberately out of scope for this round.

**P1 — episode overshoot. Not the batching logic.** The spec attributed it to
"batching into groups of 100 padding entries out". There was no batching code
anywhere in the renderer. `episodeRangeProbe()` in `playlist-inspector.ts`
generated `Array.from({ length: 200 })` synthetic episodes starting at whatever
episode the user pasted, and hardcoded `itemCount: 999`. It now fetches the
series page and reads the real count — anikoto states it in plain markup
(`Episodes: <span> 366</span>`), along with the real series title and `og:image`.
**Verified live: Bleach now probes as 366 items** (title "Bleach", not the
URL-slug "Bleach Yaa9n"), against a real count of 366. When a page states no
count, nothing is extrapolated — only the pasted episode is listed, and the note
says so. Separately, `parseInfo` now prefers yt-dlp's `playlist_count` over
`entries.length`, which the probe's own `--playlist-end 500` was capping.

**P2 — smart naming abolished.** `buildOutputTemplate` is now: single video ->
`<title>.<ext>` with no folder; confirmed playlist -> `<Playlist>/<title>.<ext>`.
`Episode (N)` and the `Season N` branch are deleted. The "folder created for a
single video" report was real and lived in the renderer, not the engine:
`CaptureView` set `folderHint` for *every* episode-range download, so grabbing
one episode still created a show folder. It is now gated on
`batchUrls.length > 1`. Note the probe step creates no directories at all — the
folder has always come from yt-dlp resolving the `-o` template.

**P3 — atomic writes, using yt-dlp's own mechanism.** `-o` is now a *relative*
template paired with `--paths home:<outputDir>` and
`--paths temp:<outputDir>/.streamdock-incomplete/<id>`. An absolute `-o`
overrides both, which is why the template had to become relative. Verified by
watching the folder during a real download: only the staging directory and the
already-finished file are visible; after a mid-download cancel the staging
directory is gone entirely. `[MoveFiles] Moving file "X" to "Y"` is now parsed
so `outputPath` tracks the final location — every earlier `Destination:` line
points inside `temp:`, so without it "Show in folder" would target a path that
no longer exists. Two gotchas worth knowing: `temp:` resolves **relative to
`home:`** (pass both absolute), and `--embed-subs` *without* `--write-subs`
deletes the `.vtt` itself after muxing — passing both is precisely what left the
subtitle files behind.

**P4 — real titles and thumbnails.** Pure data plumbing; `ProgressRow` already
rendered `item.thumbnail` and `item.title`. Nothing ever passed a thumbnail, and
`titleHint` was passed only for episode-range, so everything else queued as the
literal string "Video download". `CaptureView` now forwards the probe's title
and thumbnail for any spawn covering exactly one item (never for a spawn where
yt-dlp walks a playlist itself — one hint would name every file identically),
and the engine seeds `record.title` from it instead of the generic label.

**P5 — the duplicate wordmark was already fixed; the report predates the fix.**
Isaac's log line `[menu] Top-level menus: File, Edit, View, Help` at 18:10:59
shows no app-name entry, and commit `d8931ba` (session 6's fix) was authored at
18:14:48 — i.e. the fix was already in his working tree, uncommitted, when that
run started. The screenshot is from the 17:00:33 run, before it. Rendered the
current title bar to confirm: **exactly one "StreamDock"** on the whole page,
"Stream" in muted grey plus "Dock" in the brand gradient — which is the site's
own `nav-wordmark` treatment (`Stream<span>Dock</span>`), not a defect. Session
6 removed a *fifth top-level menu entry* labelled "StreamDock"; File/Edit/View/
Help were never touched. **No further code change was made here** — a second
speculative edit is exactly what the spec asked to avoid. Added
`tests/e2e/titlebar.spec.ts` (it asserts the rendered outcome, so a regression is
caught wherever a second copy comes from) and a `verify:engine` check that the
app-name menu stays macOS-gated.

**Also fixed, found while testing rather than reported**: `pickFatalLine` matches
`/^error:/i` but the cleanup strip was case-sensitive `/^ERROR:/`, so any
engine-thrown `Error` reached the user with a literal `Error: ` prefix.

**Verification**: typecheck (both projects), ESLint 0/0, 134 Vitest tests
(21 new, the P0 ones built from stderr copied verbatim out of Isaac's log),
`verify:engine` 44 checks, production build, Playwright 6/6. Plus live
end-to-end runs through the real `DownloadEngine`: a YouTube video completing as
`Me at the zoo.mp4` with no folder and no `.vtt`; a two-item playlist producing
one folder with real per-item titles; a mid-download cancel leaving nothing
behind; and the exact CDN 403 now reporting "The video host refused the download
(403)…" with `HTTP Error 403` visible in the details panel.

**Confirmed at runtime by Isaac's own 1.5.0 run**: the title bar log line
`[menu] Top-level menus: File, Edit, View, Help` shows no duplicate app-name
entry, closing out P5.

**Still needs Isaac at the keyboard** (no desktop automation for the Electron
window here): the queue rows rendering titles/thumbnails visually, and the
50-per-page episode pager.

**Follow-up in the same session — reported live from a 1.5.0 dev run.** Isaac
ran the build and reported missing thumbnails plus a clipboard capture that
"only puts the detected url as a placeholder". Four more defects, all confirmed
by reproduction:

1. **`start()` never ensured a probe existed.** It called `analyze()` (URL
   resolution only) and then read `probe` straight out of the React render
   closure. `probe` is `null` until `inspect()` has completed *and* re-rendered,
   so pressing Download without pressing Analyze first queued with no metadata
   at all — no title, no thumbnail, no playlist detection. Fixed by resolving an
   `activeProbe` (reusing the current one only when it matches the current URL,
   otherwise awaiting `inspect()`) and using that value throughout, never the
   closure. **This class of bug is worth watching for in this file generally:**
   several handlers read state that a sibling `setState` was supposed to have
   populated moments earlier.
2. **The metadata probe died on YouTube.** `probeViaYtDlp` ran `--dump-json`
   through a shell string with the default 1MB stdout buffer, so an ordinary
   video overflowed it (the `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` visible in the
   log). Raising the buffer fixed plain videos but *not* a radio mix, because
   without `--no-playlist` yt-dlp emits one JSON object per entry and a mix is
   effectively endless — no buffer size fixes that. Both were needed; it now
   also uses `execFile` with an argument array instead of a shell string.
3. **Playlist items never had thumbnails.** `--flat-playlist` entries carry a
   `thumbnails[]` array and no scalar `thumbnail`, and `toItem` read only the
   scalar. Every playlist row fell back to the placeholder icon in the preview
   list and the queue. `pickThumbnail()` now takes the largest array entry, and
   a playlist with no poster of its own borrows its first item's.
4. **The clipboard watcher could not fill a controlled React input.** `App.tsx`
   did `input.value = url` plus a synthetic `input` event. That assignment also
   updates React's internal value tracker, so React sees no change, never calls
   `onChange`, and re-renders the field back to its state value — an empty box
   showing its placeholder, exactly as reported. Now delivered as a prop
   (`incomingUrl`, carrying a `seq` so re-copying the same URL still counts as a
   new delivery) and applied through the same `handleInputUrl` path as typing.

Also split `displayTitle` (queue row) from `titleHint` (filename): a playlist
should show its own name in the UI without that name being forced onto every
file inside it.

**Verification technique worth repeating**: the clipboard regression test was
validated by *reverting the fix and confirming the test fails* — the first
version of it passed against the broken code, because the value only resets on
the next React render. It now forces that render by focusing the field. A
regression test that has never failed against the bug it describes is not yet a
regression test.


### Session 9 — release automation: the tag was the missing link

No code changes to the app. `package.json` stays at 1.5.0; **nothing pushed or
released** — the pipeline is built and verified locally, and publishing is
Isaac's call.

**Diagnosis, all verified against the real repo rather than assumed:**

| Link in the chain | State |
| --- | --- |
| `package.json` as version source of truth | works |
| `deploy-site.yml` syncing site + README | works — the live site was correctly at v1.4.0 |
| `release.yml` building and publishing | **works** — v1.1.0 and v1.2.0 both have real assets and its exact `name:` template |
| Pushing the tag that triggers it | **never happened since v1.2.0** |

So no workflow was broken. `release.yml` triggered only on `push: tags: ['v*']`,
and bumping the version and pushing the tag were two separate manual acts; only
the first was habitually performed. Local tags stop at v1.2.0, and so does the
remote.

**The user-visible harm was worse than a wrong number.** The site reads
`package.json` and advertised v1.4.0, while its download button points at
`releases/latest/download/StreamDock-Setup-Windows.exe` — which resolved to the
**v1.2.0** installer. The site was offering a version that did not exist and
handing over an old binary.

**Fix — the tag is now an output of the pipeline, not its precondition.**
`release.yml` triggers on a `package.json` change on main, resolves the version,
skips if `v<version>` already exists (idempotent, so the site-sync commit cannot
cause a loop), builds, and lets `softprops/action-gh-release` create the tag at
that commit. Nothing depends on a tag push triggering a workflow — which matters,
because a tag pushed with `GITHUB_TOKEN` *cannot* trigger one (the same
anti-recursion rule session 3 hit with `on: release: published`).

**Two coupling bugs found while wiring it, both would have recreated the drift:**

1. `deploy-site.yml` triggered on `push: paths: package.json`, so a version bump
   updated the site *immediately* while the release was still building — the
   site would advertise a version whose installer did not exist yet, for the
   length of a build. Removed that path; it now waits for the release workflow to
   finish, so the site can never claim a version the download button cannot serve.
2. `deploy-site.yml` passed `RELEASE_TAG: ${{ github.event.workflow_run.head_branch }}`.
   That was a tag name only while the release was tag-triggered; on a
   push-triggered run it is `main`, and `resolveVersion()` would have stripped
   the `v` and rendered the site as **"vmain"**. Dropped the override, and
   hardened `resolveVersion()` to ignore a non-semver `RELEASE_TAG`.

**Scoped the release back to Windows only, deliberately.** The rewrite initially
built all three platforms; `scripts/download-binaries.ts` fetches `yt-dlp.exe`
and BtbN's **win64** ffmpeg unconditionally, so a macOS/Linux release would have
packaged Windows executables inside a `.dmg`/`.AppImage` — installable, and
unable to download anything. ci.yml still builds those platforms as a compile
check. Making `download-binaries.ts` platform-aware is the one change needed
before adding them to the release matrix.

**Agreed plan for the next round (Isaac, session 9):** prove the Windows-only
release works end to end first, then do **Linux next** — not macOS. The work
starts in-repo (teach `download-binaries.ts` to fetch the Linux yt-dlp binary
and a linux64 ffmpeg build, add `ubuntu-latest` to the release matrix), and
Isaac will dual-boot Ubuntu to verify the resulting AppImage actually runs and
downloads. macOS stays unpublished until someone can test a real `.dmg` on
hardware — shipping an untested installer is precisely the failure mode this
repo keeps hitting.

**Guardrail**: `scripts/check-version-sync.ts` (`npm run check:version`), wired
into ci.yml as `version-guard` and added to every build job's `needs`. It fails
when the version is not semver, has no `CHANGELOG.md` section, or has moved
*below* the newest tag (which would offer existing users a downgrade via
electron-updater). It deliberately does **not** require a tag to already exist —
that would fail every version-bump commit before its own release could run.
Verified by breaking each rule in turn and watching it fail.

**Versioning approach: `npm version` + full downstream automation, not
semantic-release.** Stated in CONTRIBUTING.md with the reasoning: the drift was
never about choosing the number — that part was done correctly three times — and
semantic-release regenerates CHANGELOG.md from commit subjects, which would
destroy the root-cause narratives that are this repo's most useful artifact.

**No skill existed for this.** Checked the project, user and plugin-marketplace
skill directories; the closest, `claude-automation-recommender`, covers Claude
Code's own extensibility and is explicitly read-only.

**Verified live, not just locally.** Isaac authorised the push, and the whole
chain ran on the real repo: push to main -> `Build & Release` fired on the
package.json change (no tag involved) -> tag `v1.5.0` created by the release
step -> release published with a 302MB installer, blockmap and `latest.yml`
(v1.2.0 had no `latest.yml` at all, so **auto-update works for the first time**)
-> `Deploy Site` fired on `workflow_run` -> live site reads v1.5.0 and its
download button resolves through `releases/latest` to the **v1.5.0** installer,
200 OK. CI's new `Version Guard` job passed alongside the other eight.
A follow-up push touching only a workflow file triggered CI and *not* a second
release, confirming the paths filter and the tag-exists guard.

**Drift reconciled by cutting one consolidated v1.5.0**, not by back-filling
1.3.0/1.4.0: nobody had those versions, `electron-updater` reads `latest.yml`
from the newest release only, and building them retroactively would have
published installers missing every fix since — including session 8's P0 download
repairs. The CHANGELOG keeps both sections, so the history stays honest.

**Known rough edge, already fixed forward**: the first v1.5.0 release attached
`builder-debug.yml` because the asset glob was `release/*.yml`. It is
`release/latest*.yml` now; v1.5.0's stray asset was left in place rather than
mutating a published release.

### Session 10 — changelog truncation on the site (not a CSS bug)

Bullets on the site's changelog card were cut off mid-sentence. Reported as a
suspected CSS problem; it was not.

**The giveaway was where the cuts landed**: every one ended exactly at the first
line break of a hard-wrapped markdown bullet ("...reported as a login wall. Both
are"). Confirmed in seconds by grepping the *generated* `docs/index.html` — the
text was already absent there, so no stylesheet could be responsible. Checked
`.release` anyway to answer the question properly: no `line-clamp`, no
`max-height`, no `text-overflow`, no `nowrap`; the card sizes to content.

**Cause: a duplicated parser.** `build-site.ts`'s `renderEntry` re-parsed
`entry.body`'s raw lines with its own `/^-\s+(.*)$/`, keeping the first physical
line of each bullet and dropping the indented continuations. `parseChangelog`
had always joined them correctly, and `sync-readme.ts` used that — which is
exactly why the README was right while the site was wrong. `renderEntry` now
renders from `entry.sections`, so there is one parser and one consumer.

Same root cause, second symptom: only the *first* `###` heading was kept, so
v1.5.0's bullets all appeared under "Fixed" and "Changed" vanished.

**Guard**: `verifyChangelogRendering()` in verify-engine compares the rendered
`<li>`s against the parsed items and asserts each section heading is present —
an end-state assertion, so it catches a regression whatever causes one.
Validated by restoring the old renderer and watching it fail with
`no changelog bullet is truncated on the site`.

**Verified** with Playwright at 390/820/1440px on the live site: 34 bullets,
none clipped, zero ending mid-sentence, cards growing to fit (3504px tall on
mobile). Stress-tested with a synthetic 40-bullet release plus a 2-bullet patch:
43 bullets, zero truncated, at every width. Left the height unbounded rather
than adding a "show more" — a collapse control is what re-hides content, and
the requirement was that nothing is silently cut off.

**Noted, not changed**: at 390px the page has ~6 elements wider than the
viewport (decorative `.blob-*` gradients and the nav), but `body` has
`overflow-x: hidden` and the page is genuinely not scrollable sideways —
verified by scripting a scroll. Pre-existing and not user-visible.

### Session 11 — Linux release: platform-aware engines, and a latent empty-binaries bug

**The Linux build was already "passing" in CI and would have shipped a broken
app.** `scripts/download-binaries.ts` returned early on every non-Windows
platform with a friendly message and a clean exit, so ci.yml's Build Linux job
fetched nothing, packaged an AppImage with an empty `resources/binaries/`, and
reported success. That is the exact shape of the v1.1.0 bug (which shipped to
users with no engines at all), sitting latent and green.

**Made `download-binaries.ts` platform-aware.** A `PLATFORMS` table keyed on
`${process.platform}-${process.arch}` picks the yt-dlp asset and BtbN ffmpeg
archive per platform, extracts, and `chmod 755`s off Windows. Verified the
upstream names against the GitHub APIs rather than assuming them — this repo has
already lost a session to a guessed ffmpeg URL:

- `yt-dlp_linux` (40.4MB) — **not** the plain `yt-dlp` asset, which is the small
  zipimport build that needs a system Python a bundled app cannot assume.
- `ffmpeg-master-latest-linux64-gpl.tar.xz` on BtbN's **`latest` tag** (128.5MB),
  same rolling-tag rule as win64.
- `linux-arm64` is in the table (`yt-dlp_linux_aarch64` + `linuxarm64` archive)
  for ARM dev machines; only x64 is released.

Ordering detail that would have broken Linux silently: `chmod` must happen
*before* the `--version` age check, or a freshly written binary reports itself
unrunnable and gets re-downloaded on every invocation.

**New structural guard: `npm run check:binaries`** (`scripts/check-binaries.ts`),
wired between the download and the package step in both workflows. It asserts
each engine exists, is a plausible size, and **actually executes and prints the
version it should**. Present-and-correctly-sized is not "works": a
wrong-architecture build, a missing exec bit, or a truncated download all get
past a file-existence check and fail only when a user tries to download
something. A packaging step cannot tell "no engines needed" from "engines
missing"; this can.

**Verified without a Linux box.** WSL Ubuntu exists on this machine but could not
start (1.6GB free of 7.3GB, and killing Isaac's running app to force it was not
worth it). So the two riskiest assumptions were verified directly instead:
`yt-dlp_linux` downloads 200 and is a genuine 64-bit x86-64 ELF (checked the
magic bytes and e_machine), and the ffmpeg archive really does extract to
`<top>/bin/ffmpeg` + `bin/ffprobe`, exec-bits set, no `.exe` — streamed with
Python's `tarfile` because Windows bsdtar could not decompress 128MB of xz
inside the timeout. Windows remains unregressed (download + check both pass).

**Deliberately did NOT bump the version.** The AppImage has never been run by
anyone. ci.yml's Build Linux job uploads a `streamdock-linux` artifact on every
push to main, so Isaac can download that, boot Ubuntu and confirm it actually
runs and downloads — *then* we bump and publish. Shipping first and testing
after is the exact failure mode the last three sessions have been unwinding.
The push does touch package.json (linux build config), so Build & Release fires
and correctly no-ops: v1.5.0 is already tagged.

**macOS stays unpublished**, and it is not a build problem — CI's macOS runner
packages a `.dmg` fine. BtbN publishes no macOS ffmpeg, and an unsigned `.dmg` is
refused by Gatekeeper as "damaged" (signing + notarization needs an Apple
Developer account, ~$99/yr). ci.yml's macOS job deliberately has no engine
download or check: it is a compile check only, and `check:binaries` would
correctly fail there.

**Also**: gave the AppImage a freedesktop `category`, `synopsis` and
`description` so its generated `.desktop` entry files correctly in a Linux
application menu, and added the `libgtk`/`patchelf` system-dependency step to
release.yml's Linux job — ci.yml had it, and the job that builds the artifact
users actually download must not be the one missing it.

### Session 12 — Linux verified on real hardware; three bugs the AppImage exposed

**First session run from inside Ubuntu** (26.04, Wayland, on Isaac's dual-boot).
Version 1.5.0 -> 1.6.0, pushed, and the first release to carry a Linux asset.

**Testing method worth reusing: don't build, download the CI artifact.** ci.yml
already uploads `streamdock-linux` on every push to main, so `gh run download`
gave the exact bytes a user would get. That matters — a locally built artifact
can differ from CI's, and session 11's whole point was that the CI Linux job had
been green while packaging nothing.

**Session 11's platform-aware engine work is confirmed correct.** All three
binaries in the artifact are genuine x86-64 ELF, exec bits set, and run:
yt-dlp 2026.08.19, ffmpeg/ffprobe N-126455. The app boots clean and a real
download completes and saves. The AppImage also needs **no libfuse2** —
electron-builder 26's runtime works with fuse3 — and its desktop entry is
`Exec=AppRun --no-sandbox %U`, so users never hit Ubuntu 24.04+'s
`kernel.apparmor_restrict_unprivileged_userns=1` sandbox crash. (Running
`linux-unpacked/streamdock` directly *does* hit it: `GPU process isn't usable.
Goodbye.` That is a property of the unpacked binary, not of the shipped app.)

**Three bugs found, two of them cross-platform and long-standing.**

1. *Single videos landed in a folder named `NA`.* Session 8 fixed the
   `folderHint` route into the folder branch and missed a second one. The
   preview list auto-selects its only entry for a one-item probe, so
   `hasSelection` is true for an ordinary video; `CaptureView` then turned that
   into `playlistItems: '1'`, and `isConfirmedMultiItem()` counted any non-empty
   value as a batch. The template took its playlist branch, had no folderHint,
   and fell back to `%(playlist_title)s` — which yt-dlp renders as the literal
   `NA`. Fixed at both ends: the renderer no longer emits `playlistItems` for a
   non-playlist probe, and a selection naming exactly one item is no longer a
   batch wherever it came from (so one episode out of a series stops getting a
   folder too, which is the rule session 8 stated but only half-applied).
2. *Thumbnails rendered as a broken-image glyph.* Not a data bug — the probe
   resolved them correctly and the chosen URL returns 200. `client/index.html`'s
   CSP had `img-src 'self' data: https://*.bing.com`, a leftover from the
   wallpaper work, so every thumbnail was blocked. Session 8 added the thumbnail
   plumbing; nothing widened the policy. Now `img-src 'self' data: https:` —
   thumbnails come from whatever site is being downloaded from, which no
   allowlist can enumerate.
3. *The Linux dock icon was a generic placeholder.* electron-builder downsamples
   a single PNG into a macOS `.icns` or Windows `.ico`, but for Linux it ships
   only the sizes it is handed — `generate-icons.ts` even carried a comment
   asserting the opposite. So the lone 1024x1024 went to
   `usr/share/icons/hicolor/1024x1024/`, which the freedesktop hicolor index
   does not list (largest is 512x512), and `Icon=streamdock` resolved to
   nothing. Session 7 raised the icon to 1024 to clear macOS's 512 minimum, and
   that same change pushed Linux out of range. Now eight indexed sizes in
   `assets/icons/`, with `build.linux.icon` pointing at the directory.

**Both symptoms Isaac reported came from different layers, as usual here.** The
"settings icon in the dock" was the theme lookup failing; the "app logo on the
right of the dock" was the **system tray icon** working correctly
(`setupTray()`, electron/main.ts) — same PNG, loaded by path, bypassing the
lookup that fails for the dock. One icon, two paths, only one broken.

**Diagnosis technique that settled the icon bug in one step:** query the icon
theme directly rather than reasoning about it.
`Gtk.IconTheme.lookup_icon('streamdock', 48)` returned `NOT FOUND` with the
shipped layout installed, and resolved the instant an indexed size was added.
Available on any GTK desktop via `python3 -c "import gi; ..."`.

**Guards added, each validated by breaking it:** `verifyLinuxIcons()` in
verify-engine (asserts the end state — what `assets/icons/` holds and what
package.json points at, not what the generator does), and four naming tests that
were confirmed red against the bug, with `%(playlist_title).150B/...` visible in
the failure output.

**Known rough edge for the next session.** Session 10's `verifyChangelogRendering()`
means a version bump now *requires* regenerating `docs/index.html` in the same
commit, or verify:engine fails. But `deploy-site.yml` triggers on `docs/`
changes, so that commit publishes the site immediately — reintroducing, for the
few minutes a release takes to build, exactly the window session 9 closed when
it removed the `package.json` path trigger (site advertises a version whose
installer is not published yet; the download button still serves the previous
release). Transient and self-correcting, but the two guards are pulling against
each other and it should be resolved deliberately.

**Shipping a platform is more than publishing its asset.** Three separate bits
of site copy still described a Windows-only release after v1.6.0 went out: the
Linux download card ("Coming Soon" / "Not yet available"), the section heading
("well — Windows first"), and — the one Isaac caught by eye — an inline
`style="opacity:.5;"` on the Linux System Requirements entry, which left the
newly shipped platform looking greyed out beside an undimmed macOS that is
*not* shipped. Each was a separate place where availability had been written
down by hand. The hero button and the requirements dimming are now both derived
from the download cards, and `verifySiteRendering()` asserts a platform is
dimmed exactly when its card is `is-disabled` — validated by re-dimming Linux
and watching it fail.

**Environment note:** this Ubuntu box had no node/npm. A user-local Node 20
(`~/.local/node-v20.18.1-linux-x64`, no sudo) plus `npm ci` completed in **one
minute** — the install timeouts CLAUDE.md records are a Windows/AV problem, not
a project problem. Also of note: the Linux auto-updater logs a harmless 404 for
`latest-linux.yml` until a release actually carries one; v1.6.0 is the first
that does.

### Session 13 — a full feature audit, and the plugin system that never worked

Isaac asked for an audit of every advertised feature against the real code,
then for the easy defects to be fixed. Version 1.6.0 -> 1.6.1, released.
The audit is published at
https://claude.ai/code/artifact/94a6e449-06b0-49c3-9708-6c3c19568834 —
**with one row now wrong**, see below.

**The audit's own headline finding was itself corrected by running the binary.**
It marked bundled plugins as working, on the evidence that every piece of wiring
is present: five plugin packages ship, `resolvePluginDirs()` enumerates them,
`--plugin-dirs` is passed, electron-builder packages them. Then Isaac supplied
real URLs, `anikototv.to` failed as `Unsupported URL` despite a bundled Anikoto
extractor claiming that exact domain, and one `-v` run gave the answer:

  --plugin-dirs plugins/anikoto  -> "Plugin directories: none", 1744 extractors
  --plugin-dirs plugins          -> four packages resolved, 1750 extractors

`resolvePluginDirs()` expanded each root into its individual package folders,
carrying a comment asserting that is what yt-dlp wants. It is backwards — yt-dlp
globs `<dir>/*/yt_dlp_plugins` itself. **Every bundled plugin had been inert in
every build ever shipped.** Fixing it exposed a second problem: yt-dlp loads
every package under a root, and `ChromeCookieUnlock` imports `windll` at module
level, so off Windows it printed an ImportError traceback on every invocation —
into the stderr the failure-details panel shows users. It moved to its own
`plugins-win/` root, offered only on Windows.

**Three defects fixed, all cross-platform and long-standing.**

1. *Subtitles were embedded whatever the user chose.*
   `applyLanguageAndSubtitleArgs` honoured the picker and `applyYtDlpOptions`
   then appended `--embed-subs` from a global setting whose persisted default
   was `true`. "None" still embedded; "Sidecar" embedded *and* wrote the file.
   Checked against the engine rather than assumed —
   `--skip-download` gives `requested_subtitles=NA`, adding `--embed-subs` gives
   `{'en': {...}}` — so it was never harmless. The fix is structural:
   `shared/subtitle-args.ts` owns the entire decision and the engine emits no
   subtitle flags of its own. Mode gained `'both'`, so sidecar / embedded /
   both are now distinct. Burned-in subtitles stay unimplemented on purpose.
2. *The quality picker fabricated its options.* Isaac's premise was that there
   is no quality selector; there is one, always rendered. The real defect was
   `fallbackQualityChoices()` supplying a hardcoded 1080/720/480/360 ladder
   whenever nothing had been detected — before Analyze, for every playlist, and
   for every episode-range probe, because `qualityOptions` is only populated
   when `entries.length === 0`. Now `client/src/lib/quality.ts` offers only
   detected heights, and "Best quality" alone when there are none.
3. *A saved subtitle default never reached the picker.* Found while wiring the
   setting: App loads settings asynchronously and `useState` reads its initial
   value once, so the stored value arrived after CaptureView had already
   captured the fallback. The class of bug this file already warns about.

**The quality semantics were already correct and were deliberately left alone.**
Verified with one shared selector across two videos of different maximum
resolution: `-f 'bestvideo[height<=1080]+...'` gave 240p and 720p — the 240p
video was neither skipped nor upscaled. `height<=N` is a ceiling, so an explicit
pick already means "best available, up to N", which is the Option C Isaac
preferred. What was missing was saying so, so options read "up to 1080p" and the
preview line states that each item downloads at its own best.

**`shared/` is a new third tsconfig root**, included by both projects. The
renderer needs the same subtitle rules the engine uses in order to preview them
honestly, and this repo has already lost a session to the same logic existing
twice (the site and README rendering one changelog through two parsers).

**URL fixtures, measured with the real binary.** Both YouTube playlist forms
behave identically (15 items, real title and thumbnail) and both report
`qualities: NONE` — a live confirmation of the playlist gap. `reanime.to`,
`animex.one` and `rivestream.app` are **absent from `host-config.json`
entirely**, so they never reach the manifest extractor and fail as unsupported
links. `shuttletv.su` is in `manifestProbeHosts` but its episode pattern needs
`?e=`, which the sample URL lacks. `anikototv.to` now reaches its extractor and
fails on the site's current markup — plugin-versus-site drift, not a StreamDock
defect.

**What could not be tested, and is exactly what those hosts need:** the hidden
`BrowserWindow` manifest extractor requires a real Electron session. Moving on
host coverage needs Isaac to run the app against one of these URLs and share
`streamdock.log`.

**Guards added, each validated by reintroducing the bug:**
`verifySubtitleOwnership` (the engine emits no subtitle flags, and no `-vf`
anywhere, so burned-in subtitles cannot appear as a side effect),
`verifySubtitleModesOffered`, `verifyNoFabricatedQualities`, plus two
`resolvePluginDirs` tests that assert the returned paths are *roots containing
no package name* — a test that merely counted directories would have passed
against the defect.

**Also**: removed a Playwright test that was permanently skipping. The subtitle
picker sits behind a probe and is unreachable in a network-free run, and a
skipped test reads as coverage it does not provide; its assertion moved to
verify-engine where it actually runs.

**`HANDOVER.md` was added** at Isaac's request for the next clean session,
including a task to evaluate `sdaqo/anipy-cli` and `pystardust/ani-cli` for
provider coverage. Both are **GPL-3.0 and StreamDock is MIT**, so that file
states plainly: study them for facts (which hosts exist, how a provider
behaves), never copy or closely adapt their code. Noted there too: the repo has
**no `LICENSE` file at all**, despite `package.json` and the site footer both
claiming MIT.

**Verification**: typecheck, ESLint 0/0, 172 Vitest tests (30 new),
verify:engine 96 checks, Playwright 10/10 with no skips, production build, and
v1.6.1 published with Windows and Linux assets, both update manifests, and the
site reading 1.6.1.

### Session 14 — provider recon, episode patterns as data, one language model

No version bump, **nothing released**. Three commits on
`claude/test-linux-version-1b43c0`. The audit-and-recommend half is published at
https://claude.ai/code/artifact/1e3136ea-3954-4808-8498-584f840951af

**The reference-project evaluation (handover task 1) answered: don't adopt
either.** Neither `ani-cli` nor `anipy-cli` supports a single host StreamDock
targets, nor any of Isaac's four failing samples — grepping both codebases for
anikoto, megacloud, shuttletv, reanime, animex, rivestream, hianime, aniwatch,
animepahe and gojoora returns nothing. Measured live rather than read off their
READMEs: `anidb.app` serves an **"Under Maintenance" page**, and it is
`ani-cli`'s *only* backend — the 13.7k-star tool is non-functional today.
`animekai.to` is unreachable and its decoder feed `kai.json` is 404. Only
AllAnime (`api.mkissa.net`) is healthy; its search API was confirmed returning
real JSON.

Two things from them were worth taking, as designs rather than code (both are
GPL-3.0, StreamDock is MIT — verified from each repo, not inherited):
`anipy-cli` contains **no browser automation at all** (requests + BeautifulSoup),
so this extraction class is headless and therefore CI-testable, which the hidden
`BrowserWindow` has never been; and they model language as a **tri-state
sub/dub/raw carried as provider data**, chosen before the episode lookup.
Their hardest step is one to avoid: AllAnime's video endpoint needs a rotating
AES-GCM token whose key lives in a JSON file on the maintainer's own GitHub
branch — a model that has already failed once, since AnimeKai's equivalent feed
is the 404 above.

**The real find was incidental, and corrects a recorded diagnosis.** `ani-cli`'s
README links `vorlie/ani-cli-rs`, which targets Anikoto. Running StreamDock's
*own* bundled plugin against Isaac's URL shape showed the catalogue layer
**works** — it resolves the series, finds the episode, gets a stream server —
then hands off to `https://vidtube.site/stream/<token>/sub`, while the embed
extractor only matches `(?:vidwish|megaplay)\.(?:buzz|live)/stream/s-2/…`.
New embed host, new path shape, no extractor claims it, generic falls through,
and a regex returning `None` produces the `'NoneType' object has no attribute
'group'`. **It is a coverage gap in one pattern, not "markup drift"**, and the
extractor body is host-agnostic. Not fixed here, and not to be promised as a
one-liner: resolving the equivalent `megaplay.buzz` embed by hand returned real
subtitle tracks but the video sources came back under an encrypted `enc` field,
and `ani-cli-rs` has no decryption at all, so it would fail the same way.
Also found: `anikotoapi.site` responds 200 and self-declares
`"anikoto_domains":["anikototv.to","anikoto.cz"]`, returning real titles,
posters, per-language episode counts and a ready-made embed URL per episode,
with a slug shape matching Isaac's sample URL exactly.

**Episode patterns are data now.** `detectEpisodePattern()` matched two hosts by
literal regex written into the function. `anikototv.to` is in
`pluginExtractorHosts`, `manifestProbeHosts` and `animeHosts` and uses
byte-for-byte the same `/watch/<slug>/ep-<n>` shape as `anikoto.cz`, but only
`anikoto.cz` was in that function — so the host Isaac actually pastes never
produced an episode range, silently. Patterns moved to `host-config.json`: each
names its hosts, a path regex exposing a `series` group, and exactly one of
`episodeParam` (query string, shuttletv) or `nextPath` (path, anikoto). Read as
untrusted like the rest of the config — a pattern that fails to compile is
skipped rather than killing probing for every other host. Verified against the
**shipped** config, not only the fallback the tests can reach.

**The language classifier was not two copies — it was four.** The handover
recorded two (`manifest-parser` vs `stream-options-probe`). The probe alone held
four: `classifyLanguage`, `normalizeLanguageLabel`, `inferLabelFromManifestUrl`,
and the yt-dlp branch's label path. Each was slightly different and all fed the
same badge that also shows genuinely declared languages. Both substring forms
produced confident wrong answers — `includes('en')` matches *generic*, *screen*,
*engine* and *segment*, so most CDN paths classified as English, and
`includes('hub')` returned a language called "Hub", matching *animehub*,
*github* and *cdn-hub*. `shared/language.ts` is the single model: tri-state
translation independent of spoken language, plus the field those CLIs do not
need and StreamDock does — **`confidence`**, so an inferred value is styled and
marked differently in the picker and a guess never reads as a fact.
`electron/language-registry.ts` deliberately stays the authority for *declared*
manifest languages: it handles regional codes (`en-us`, `pt-br`, `zh-hans`) the
inference model has no business guessing at, and it was never the side that
lied. The bug was two paths answering one question, not two modules existing.

**MIT `LICENSE` added.** `package.json` and the site footer had claimed MIT
since the beginning while the repo carried no licence text at all.

**Verification**: typecheck (both projects), ESLint 0/0, **192 Vitest tests**
(20 new), `verify:engine` **124 checks** (up from 96, two new guards), Playwright
10/10, production build. Every new test and both new guards were confirmed red
against the bug before being kept — the seven behavioural language tests were
run against the restored old classifier, and the episode guard against the old
host list.

**Still unverified — needs Isaac at the keyboard**: the inferred-language badge
rendering in the real app, and an anikototv.to episode range probed through the
UI rather than through `detectEpisodePattern` directly.

### Session 15 — the 403 was a wrong header; dub works; one owner per choice

Version 1.6.1 -> **1.7.0**, released. Eleven commits. This session was driven by
Isaac testing each change in the real app and reporting back, which is why so
much of what follows corrects things earlier sessions recorded as settled.

**The anikoto 403 was never a Cloudflare wall.** Session 8 recorded it as bot
management that rejected every `--impersonate` target and concluded it was "not
StreamDock's to fix". Measured against the live CDN with a fresh token:

  no UA, no referer            -> 403
  UA only                      -> 403
  UA + the anikoto page URL    -> 403   <- what the engine was sending
  UA + https://megaplay.buzz/  -> 200   <- the player's origin
  UA + vidtube.site / the CDN itself / anything else -> 403

Zero cookies are set for the CDN and plain Node https succeeds with the right
referer, so there is no challenge and no browser session needed. Stream options
carried `referer: pageUrl`; the manifest is fetched by the *player*, on a
different origin. **The misdirection came from yt-dlp**, which reports any 403
from a Cloudflare-fronted host as `Got HTTP Error 403 caused by Cloudflare
anti-bot challenge` whatever the cause. Proven end to end: same manifest, old
referer 403s, captured referer gives 307 fragments and a 213MB 1080p file.

The referer is now **read from the intercepted request** rather than hardcoded,
in both routes — `stream-options-probe` via `onBeforeSendHeaders`, and
`manifest-extractor` via `details.referrer` (it cancels the request, so no
header hook fires). Fixing only the first left batches still failing, which is
the "two routes into the same branch" shape this file already warns about.

**Dub genuinely works now, and did not before.** `extractManifest` took no
language argument at all, so every episode resolved to whatever the page loads —
and anikoto opens on SUB. Choosing Dub gave a whole series in Japanese.
Measured per episode: `default == sub` on both episodes tested, and dub is a
different stream (1440x1080 / 1384.6s versus 1920x1080 / 1394.5s, different
audio). Confirmed by Isaac on episodes 1 and 2.

**Why detection is per-episode and not one pass up front** — the shape
originally proposed. The CDN token inside a manifest URL was measured good for
about 90 seconds: 200 at t+0 and t+60, **403 at t+120 and t+180**, with an
expiry ~90s after minting encoded in the token itself. Resolving 366 links
before starting would take ~15 minutes and every link would be dead on arrival.
So the manifest cannot be carried across a batch but the *choice* can. The
extractor also **ignores manifests until the requested language is selected**,
or the SUB stream the page loads on its own is captured before the switch.

**Three bugs found by Isaac testing, each hiding the next.**
1. *An episode range downloaded one episode N times.* The renderer applied the
   probed `manifestUrl` to every URL in the batch. Five rows, five progress
   bars, one episode — proven from the files: episodes 1 and 3 byte-identical,
   and a frame at 10:00 identical across all five.
2. *A self-inflicted 429.* A "one probe-host download at a time" guard existed,
   but the engine rewrites `request.url` to the CDN manifest once resolved, and
   the guard filtered on that field — so running downloads became invisible to
   their own limiter. All five spawned within 59ms. Tasks now record the URL
   they were queued for.
3. *A skipped file reported as a fresh download.* `--no-overwrites` exits 0 with
   "has already been downloaded"; nothing parsed it, so a 200MB episode
   "completed" in six seconds and stale files silently masked whether a fix
   worked at all. Rows read **Already saved** now.

**A timeout that hung inside itself.** A download sat on "starting" forever with
nothing logged after `Probing …`. The 45s extraction timeout *had* fired — its
last-resort `win.webContents.executeJavaScript` never settles against a hung
renderer, so neither `.then` nor `.catch` ran and `finish()` was never called.
`fetchUrlRaw` on the same path had no timeout at all. Three deadlines now, and
the engine races `extractManifest` against a ceiling so a third hang of that
shape cannot stall a serialised queue.

**UI: one owner per choice.** Language, audio and subtitles were each settable
from two or three screens, and the always-visible copies were often the ones
that could not work — Advanced offered "Audio: English dub" for sources where
`--format-sort lang:` cannot act, while the control that works sat behind a
button. Now: the main row owns every choice the source offers and each appears
only when detection found it, the dialog owns per-track detail alone, and
Advanced is "Connection settings" with impersonation only. Before Analyze there
is nothing but URL and Quality. Audio preference and stream language are
mutually exclusive, since they answer one question by different mechanisms.

**Also**: episode patterns moved from literal regexes in `detectEpisodePattern`
into `host-config.json` (which is why `anikototv.to` never produced a range —
present in every host array, absent from that one function); episode counts read
from the site's own series API via the `data-id` on the page (One Piece: 1177,
not 1); the language classifier merged — the handover said two copies, the probe
alone held **four**, and a guard written against the *symptom* (`includes('en')`
anywhere in the file) is what surfaced the extra two; and the MIT `LICENSE` the
repo had always claimed but never carried.

**Verification**: typecheck, ESLint 0/0, 207 Vitest tests, verify:engine **162
checks** (from 96), Playwright 12/12, production build, `check:binaries`. Every
new test and guard validated by reintroducing its bug. Plus real downloads
through the app and through harnesses driving the actual engine in a real
Electron session.

### Session 16 — repo audit, then the cleanup it justified

No version bump, **nothing released**. A full read-only audit first
(published at https://claude.ai/code/artifact/765663e6-8ee5-4ef6-9488-fa6934bac63b),
then only the removals that audit had traced to evidence. The full pipeline was
run before *and* after, and was green both times: 207 tests, 162 engine checks,
Playwright 12/12, ESLint 0/0, typecheck, production build.

**Removed, each traced to zero references before deletion:**

- Both `*.tsbuildinfo` files — tracked TypeScript incremental state, 124KB
  carrying **311 `node_modules/` path references**, re-committed across 17
  commits including the v1.7.0 release commit. Untracked, and `*.tsbuildinfo`
  ignored. Flagged twice in HANDOVER and deferred twice.
- `info.json` — a UTF-16LE `yt-dlp --dump-json` dump of an anikoto episode. The
  UTF-16 encoding is a PowerShell redirect signature; it was swept into the
  wallpaper commit `9b47c04`.
- `icons-cards.png`, `icons-pills.png`, `icons-reqs.png` — 106KB of screenshots
  from `4a37b64`'s visual verification of the site, committed at the repo root.
- `plan.md` — the pre-implementation plan, which **contradicted shipped
  behaviour**: it specified the `Season N/Episode NN` naming session 8 abolished,
  and named `everythingmoe.com` as a site to research when `verify:engine` now
  guards against its reintroduction. Recoverable from git (`git show 73c7129:plan.md`).
- `.vscode/settings.json` — tracked and empty (`{}`).
- `assets/logo.svg` — referenced by nothing but `plan.md`.
- Six unused dependencies: `class-variance-authority`, `clsx`, `tailwind-merge`
  and `react-error-boundary` (all **runtime**, so they shipped inside the app —
  the shadcn/ui trio without shadcn, plus an error-boundary package while
  `main.tsx` hand-rolls its own class), and dev-only `jsdom` (Vitest is
  configured for happy-dom) and `source-map`.
- Dead code: `playComplete()`/`playError()` in `client/src/lib/audio.ts` (never
  called; `playDiscovery`/`playPop` are), `getLanguageFlag()` plus its orphaned
  `LANGUAGE_FLAGS` table in `language-registry.ts` (the live flag table is the
  renderer's), `resolvePackagingMode()` in `media-track-probe.ts` — a
  **byte-identical duplicate** of the renderer's tested `computePackagingMode` —
  and its now-unused local `DownloadPackagingMode`, and two `console.log` calls
  dumping full probe payloads on the success path in shipped renderer code.

**`scripts/download-plugins.ts` was repaired rather than deleted, because it
would have reintroduced a fixed user-facing bug.** Unchanged since the initial
commit, it wrote ChromeCookieUnlock into `plugins/` — undoing session 13's
`plugins-win/` split, which exists because that package imports `windll` at
module level and prints an ImportError traceback into the stderr users see. It
had **no mention of `plugins-win` at all**, listed `anime-media-fetcher` (not
vendored here), and `rmSync`s each vendored plugin before replacing it with
upstream HEAD. It now routes per-package to the correct root and reproduces
exactly the committed set. Its `branch` field was always dead data — the loop
tries `master` then `main` regardless.

**Then running it found two more things that reading it had not.** It was run
against a scratch directory (`process.cwd()` decides where it writes, so this is
safe and needs no flag) rather than in the repo, because running it in place
rewrites vendored code by design.

1. *It had never worked on Linux or macOS at all — every package failed.* It
   extracted with a bare `tar -xf` on a GitHub **zip**, and GNU tar cannot read a
   zip ("This does not look like a tar archive"). The failure was swallowed by
   the loop's catch and surfaced only as "FAILED to install … from any branch",
   which reads like a network problem. This is the same trap session 4 hit in
   `download-binaries.ts`; that fix was never carried across. `extractZip()` now
   uses Windows' bsdtar (`System32\tar.exe`) there and `unzip` elsewhere. Note
   `download-binaries.ts` is *not* affected — it only ever hands tar a `.zip` on
   Windows and a `.tar.xz` on Linux — though its comment claiming one invocation
   covers both formats is optimistic.
2. *`Tons-7/yt-dlp-aniwatchtv-kaido` is gone* — 404 on the repo page, the API and
   both branch archives. **`plugins/aniwatchtv-kaido/` is now the only surviving
   copy** of the aniwatch, kaido and megacloud extractors. Its entry carries
   `repo: null` and is skipped with an explanation, so the vendored copy is never
   deleted and the skip is not mistaken for a bug.

Verified end to end: four packages refresh, ChromeCookieUnlock lands in
`plugins-win/`, the rest in `plugins/`, and the resulting layout matches the
committed one exactly apart from the deliberately-skipped package.

**Config fixes, each verified by running the thing:**

- `vite.config.ts` had `publicDir: 'assets'` — the same folder electron-builder
  takes *installer* icons from, so every build copied `icon.ico`, `icon.png` and
  the eight Linux sizes (~965KB) into `dist/client/` and from there into the
  asar. The renderer requests none of them; it draws its mark as inline SVG.
  Set to `false`; **`dist/client` went from ~1.2MB to 288KB**. Safe because
  `main.ts` resolves icons from `process.resourcesPath` / `app.getAppPath()`,
  never from `dist/client` — checked before changing it.
- ESLint no longer ignores `scripts/**`. **All 14 scripts had gone unlinted**,
  which is part of how `download-plugins.ts` drifted; it held two of the three
  warnings this surfaced. Added a real `lint` script so CI and humans run one
  command, and dropped `--ext .ts,.tsx` from CI, which is a no-op under flat
  config (verified: identical result with and without).
- Coverage excluded `electron/**` while **10 of 15 test files test it**. Now
  included — which immediately exposed that the suites themselves and the
  Playwright specs were being measured too, distorting the total in opposite
  directions. With all three fixed the number is honest and interpretable for
  the first time: shared 97.7%, client/src/lib 34.9%, electron 14.8%.
- `.gitignore` gained `*.tsbuildinfo`, `coverage/`, `.claude/`,
  `RELEASE_NOTES.md`, `.env*` and `.vscode/`. `.claude/` matters most: HANDOVER
  said `launch.json` "must stay that way", but nothing enforced it, and that
  directory also holds **entire git worktree checkouts**.
- CI: dropped the `develop` branch trigger (no such branch on origin), removed
  `npm run build:app` from the E2E job (the specs run against Vite from source,
  so `dist/` was never consumed), and fixed the Playwright artifact — it
  uploaded `test-results/` under the name `playwright-report`, so the HTML
  report the name promised was never in it.

**One import was left alone after investigation.** `release-notes.ts` imported
`entryForVersion` and used an inline `.find()` instead. Swapping to the helper
looked like obvious de-duplication — but `entryForVersion` falls back to
`entries[0]`, which for release notes would silently attach the *previous*
version's notes to a new release. The inline exact match is deliberate; only the
dead import was removed, and the reason is now a comment.

**The pipeline pass came next, and the run history settled two things reading
could not.**

- *The release window session 9 closed had reopened, and it is not theoretical —
  it happened on v1.7.0.* `deploy-site.yml` no longer triggers on `package.json`,
  but its push paths still listed `CHANGELOG.md`, and a release commit edits
  both. On the real v1.7.0 push both workflows started at 15:13:08: Deploy Site
  finished at **15:13:37** publishing "1.7.0" to the site, while Build & Release
  did not publish the installer until **15:17:03**. For 3m26s the site
  advertised a version whose installer did not exist and the download button
  served v1.6.1. Fixed by dropping that path; the `workflow_run` trigger already
  covers releases and waits for the installers (it is the 15:17:06 run).
- *Codecov had never once worked.* Its step reported `Token required - not valid
  tokenless upload` three times per run **and** `not_found_files:
  ["coverage/lcov.info"]` — no `CODECOV_TOKEN` is configured, and vitest's
  reporters are `text/json/html`, so the lcov file it uploads was never
  generated either. `fail_ci_if_error: false` hid both, on every run, forever.
  Removed, with the two things needed to re-enable it written where the step was.

Also: **a release could publish without passing anything.** `build` depended
only on `check`, so nothing stopped a commit with a failing typecheck, lint or
test from being packaged and published — ci.yml runs on the same commit but in a
separate workflow whose result release.yml never observed. There is now a
`quality` job (the same gate ci.yml requires before packaging) that `build`
depends on.

Rounding it out: **concurrency groups** on all three workflows (deploy-site
pushes to main, so two overlapping runs raced on the same branch; release runs
raced to create the same tag — both queue rather than cancel, while CI cancels
superseded runs); **timeouts** on every job, which previously inherited the
6-hour default; **artifact globs** instead of `path: release/`, measured by
packaging locally — `release/` is 913 MB for Linux because electron-builder also
leaves the 647 MB unpacked app there, so every push to main uploaded that, per
platform (now 267 MB, still the AppImage this repo tests with); **action
versions**, all six of which GitHub reports as targeting the deprecated Node 20
runtime — bumped to the majors that target Node 24 only after reading each
release note, which is why checkout stops at v5 rather than the current v7
(v7 changes `workflow_run` checkout behaviour, and `deploy-site.yml` runs on
`workflow_run`); and **least-privilege permissions** in release.yml, where
`build` runs npm installs and downloaded engine binaries and no longer holds a
repo-write token — only `publish` does.

The duplicate packaging is gone too: a release commit was packaged by both
workflows, so ci.yml now asks "will release.yml package this commit?" by
mirroring release.yml's own decision exactly (package.json changed **and**
`v<version>` untagged) and skips Windows/Linux when the answer is yes. macOS is
never gated, because release.yml never builds it.


### Session 17 — the screenshots carousel on the site

No version bump, **nothing released**. Site only; no app code touched. The
screenshots came from `Screenshots/` at the repo root — **untracked, and not
present in a worktree**, which is worth knowing before hunting for it.

**Eight of the ten shots are on the site**, as a centre-mode autoplay carousel
between the hero and "Choose your platform" (Isaac's call: people should see it
working before they are asked to pick a platform).

- **`Screenshots/live capture.png` is deliberately not listed.** It is 551x148 —
  a crop of the clipboard toast, not a window capture — against 2544x1644 shots
  in a 3:2 frame. It would be upscaled ~3x. One JSON entry adds it back if a
  full-window version is ever taken.
- **`unsupported links.png` was included and then dropped at Isaac's request.**
  It was captioned "It tells you when it can't", on the argument that honest
  failure reporting is a differentiator. His call was that a landing page should
  not lead with a red ERROR block, and that is the right call for a page whose
  job is a download. Re-adding it is one entry — ask first.

**The list is data.** `docs/screenshots.json` holds `{id, source, title,
caption, alt}` per shot and is the only place a screenshot is named.
`scripts/lib/screenshots.ts` is the single reader — `optimize-screenshots.ts`
encodes from it, `build-site.ts` generates slides/captions/segments from it, and
`verify-engine.ts` checks the page against it. Three consumers, one parser, on
purpose: the site and the README rendered one changelog through two parsers for
months and only one of them was right.

**Images: 14 MB of PNG became 689 KB of WebP** at two widths (800/1600) via
`npm run screenshots:build`. It encodes with Playwright's Chromium canvas —
already a devDependency, the same reason `generate-icons.ts` rasterizes with it,
and no new native module. The sources are **not committed**; the committed
artifact is the .webp set, and the script says exactly that when the source
folder is absent. Two guards inside it earn their keep: Chromium silently
returns a *PNG* data URL when it cannot encode the requested type, and a
successful-looking encode under 4 KB is a blank canvas.

**No new dependency, and no carousel library.** Plain CSS transforms plus one
vanilla IIFE in the site's existing style.

**One timer owns both the advance and the fill.** The progress bar is not an
animation running alongside a `setInterval` — it is the elapsed hold rendered,
so they cannot drift and a manual jump resets both by resetting one number.
`requestAnimationFrame`, not `setInterval`/CSS animation, because it stops by
itself in a background tab; the frame delta is clamped to 100 ms so returning to
a tab **resumes** the hold rather than firing through every slide that
"elapsed" while nobody was watching.

**Three things that were nearly wrong, each caught by measuring:**

1. *The slides would have flown in across the stage on first paint.* Serving
   every slide parked off-stage and letting JS correct it on load is the obvious
   shape and the wrong one: the transform transition fires on the correction, so
   the left-hand slides visibly travel in from the right. `build-site.ts` now
   runs the same ring arithmetic the script does and serves each slide on its
   final `data-pos`, and `verify-engine` asserts the two agree.
2. *Adding a fifth nav link pushed the Download CTA off the right edge* between
   721 px and ~900 px — the row only just fitted at four. Found by measuring
   `scrollWidth` against `clientWidth`, not by looking. A tightened gap and
   padding under 960 px keeps every link reachable.
3. *The first guard I wrote had a false positive and then a false negative.*
   "The carousel script names no screenshot" tripped on the word *capture* in a
   comment about pointer capture; stripping comments then made it pass wrongly,
   because the regex anchored on the string "Screenshots carousel", which
   appears **first in the stylesheet banner** — so it was matching from `<style>`
   through the generated `<img>` tags. It is anchored on the script's own first
   statement now. A guard that matches prose is not guarding code.

**The mobile peek is set by `--shot-w`, not by the step.** The visible sliver at
each edge is (half the window − half the centre slide); moving the neighbours
closer or further does nothing, because they sit *behind* the centre. At 86vw it
was 27 px and read as a rendering artefact; 80vw makes it 39 px.

**Verified live at 1440/820/390** in a real browser, not by reading CSS: autoplay
advancing and the fill resetting, click-a-side-slide, prev/next, segment clicks,
arrow keys, hover-pause and resume, swipe left/right, and that a 15 px drag and a
vertical drag both change nothing (vertical page scroll survives). Horizontal
overflow checked at every width — `scrollWidth === clientWidth`, and the page
does not scroll sideways. `prefers-reduced-motion: reduce` confirmed with
Playwright's emulation: **no advance in 7 s**, against an advance in the same
window without it.

**Guards: `verify:engine` is at 241 checks (from 162)**, and every one of the
five conditions `verifyScreenshotCarousel` claims was confirmed red against its
bug — a deleted .webp, a wrong start position, a truncated caption, a
caption-count mismatch, and an asset path in the script.

**A pre-existing anchor bug, found here and then fixed at Isaac's request:**
`#download`'s section label landed at y=40 under a 75 px sticky nav, so the
site's own "Download" nav button — and every hero platform pill — scrolled to a
heading the nav was covering. It has 40 px of top padding where `.features` has
80 px, which is why only that one section was affected. Both now carry
`scroll-margin-top: 88px`. All four in-page anchors are measured clear of the
nav on load and on click (`#screenshots` 112, `#download` 128, `#features` 80,
`#requirements` 432).

**Review pass — five defects, four of them only findable by driving a real
browser.** The implementation above was measured rather than re-read: 51
behavioural assertions across three Playwright suites (geometry, autoplay
timing, a11y, responsive, real touch), each run against the live page.

1. *A mouse swipe did nothing at all.* Chromium treats an `<img>` as a native
   drag source: the gesture fires `dragstart` and then delivers **no
   pointerup**, so the release handler never ran. This is session 4's wallpaper
   button trap, in a second place, exactly as the working agreement about
   carrying a fix across every site of the same bug predicts. Fixed with
   `draggable="false"` plus a cancelled `dragstart` (Firefox honours no
   equivalent attribute). **The earlier phase's own swipe test passed against
   this bug** — it dispatched synthetic `PointerEvent`s, and dispatched events
   do not start native drag-and-drop. A test that cannot reach the failure is
   not covering it.
2. *Clicking a progress dot with a mouse stalled autoplay permanently.* A click
   leaves DOM focus on the button it hit, `focusin` set `focused = true`, and
   nothing ever cleared it. Pausing on focus is for the keyboard user who just
   tabbed to a slide, so it now consults `:focus-visible` — the browser's own
   judgement about which kind of focus just happened.
3. *Four invisible slides were keyboard-focusable and announced.* Slides parked
   off-stage sit at opacity 0; left in the tab order they take focus into
   nothing, and a screen reader reads four screenshots nobody can see. They now
   carry `tabindex="-1"` and `aria-hidden="true"` together — aria-hidden on a
   focusable element is itself an error — maintained by `render()` and served
   that way by the generator, so it is right before the first frame of script.
4. *The animation loop never stopped.* `requestAnimationFrame` ran for the life
   of the page and returned early when paused, so a visitor who never scrolled
   to the section still paid a callback every frame. It is started and
   cancelled now; `lastTs` is cleared on every stop, or the first frame after a
   resume banks the whole paused interval as elapsed time.
5. *`pointermove` was bound to `window` for the life of the page* behind an
   `if (!dragging)`. It is attached on pointerdown and removed on release.

**Payload cut 37% by adding one number.** All nine slides were being fetched at
1600w — `sizes` claims 860 px on desktop and the only candidate at or above it
was 1600. Adding a 1200w candidate to `SCREENSHOT_WIDTHS` (one edit; the
optimizer, the generated srcset and the guard all read that list) gives:
1x desktop 493→310 KB, 2x tablet 493→310 KB, 1x tablet 196 KB, 2x desktop
unchanged at 493 KB. (Measured with nine shots; the set is eight now.)

**Two false results worth recording, both mine.** A hold measured as 3939 ms
looked like a timing bug and was a partially-elapsed hold — hovering preserves
`elapsed`, so the first gap after an unhover is short by design. And a mobile
"tap a side slide" failure was a bad coordinate in the test, not a dead
control: the side slide's box is mostly *behind* the centre, so the tap has to
land on the visible sliver at the window edge. Both were confirmed by
instrumenting the page rather than by adjusting the assertion until it passed.

**Also**: the optimizer now validates every source before it deletes anything
and then rebuilds the output directory from scratch, so a removed shot cannot
leave an orphaned `.webp` behind and a missing source cannot leave the
committed assets half-deleted. `verify:engine` is at **272 checks**; the three
new guards (off-stage focusability, the script maintaining it, and
non-draggable images) were each confirmed red against their bug.


**Follow-up — the carousel was sized by width only, and overflowed short
viewports.** Isaac reported the section title and the caption falling off screen
and sent a browser screenshot; his viewport is about 1440x664, a laptop with a
bookmarks bar and a sidebar. Measured: the section was **961px tall on every
screen whatever its height**, because `--shot-w` was `min(58vw, 860px)` — two
width terms and nothing else. It overflowed his viewport by ~300px, and by 21px
even on the 940px-tall bench this session had been testing against. Every
earlier check passed because they only ever asked about *horizontal* overflow.

The fix is a third term in the same `min()`: `--shot-limit`, the height left
after the section's own furniture, converted back through the aspect ratio into
a width. A tall window is capped by width, a short one by height, and the whole
section fits either way. `svh` rather than `dvh` — `dvh` changes as a mobile URL
bar hides and would resize the carousel mid-scroll — with a `vh` line beneath it
as the fallback. The furniture constant was measured, not guessed: 289px of
non-stage content plus a 26px stage pad, so 322px, and the first attempt at 300
overflowed by exactly the 15px it was short.

Also trimmed, all locally so other sections keep the site's rhythm: section
padding, the label and title margins, and the gaps under the stage — 349px of
furniture down to 289. The stage no longer reserves 72px of height for the
centre slide's shadow either: `overflow-x: clip` with `overflow-y: visible`
clips the slides horizontally while letting the shadow spill into the gap
below, with plain `overflow: hidden` declared first as the fallback for
browsers without `clip`.

Result across a 14-viewport matrix: every realistic size fits with slack to
spare, aspect ratio 1.547 preserved throughout, and the centre slide is 720px
wide on a normal desktop, 529px on Isaac's, 780px on a large screen. Only a
landscape phone (844x390) still overflows, by 64px, and no amount of shrinking
the image fixes that — the title, caption and progress row are ~300px on their
own, so the furniture is the binding constraint there.

**A second horizontal overflow, from the same nav link as before.** The
`.nav-links` row bottoms out at 781px wide with four text links and the CTA, so
below ~800px the Download button was pushed off the right edge — measured at
736px and 768px as the only element contributing to `scrollWidth`. Session 17's
first fix tightened the gap and padding and was verified at 820px only; the
links now hide at 820px rather than 720px. **Tuning a responsive fix at one
width proves it at one width.**

`verify:engine` is at 264 checks. The new guard asserts every breakpoint's
`--shot-w` consults `--shot-limit` and that `--shot-limit` comes from a
viewport-height unit — structural, because whether a section fits a viewport is
a rendered-layout fact a static script cannot evaluate, and a regression to
width-only sizing brings the whole bug back.

### Session 18 — the shared drive: line endings, a Windows node_modules, and a dependency audit

No app code changed. Three commits, all infrastructure, driven by a `git pull`
that failed. The through-line: **this repo lives on one drive that both a
Windows boot and a Linux boot write to, and almost everything here follows from
that.**

**The failed pull was not a git problem.** The primary checkout was 34 commits
behind with 30 modified files, and `pull --ff-only` refused. The diff stat named
the cause before any file was read: **9097 insertions and 9097 deletions,
exactly equal** — a line-ending change, not edits. Confirmed by every text file
carrying 100% CRLF while HEAD carried none, and by `git diff --ignore-cr-at-eol`
coming back empty apart from three PNGs upstream had already deleted. Nothing to
preserve; `reset --hard origin/main` was safe, and the state was archived first
anyway.

`.gitattributes` now pins `* text=auto eol=lf`, with png/ico/webp declared
binary. **`eol=lf`, not a bare `text=auto`**: the latter normalises what is
*stored* but still checks out CRLF on Windows, so a shared checkout keeps
flip-flopping. Renormalisation produced **zero churn** — the tree was already LF
— so the commit touches no source file.

*Proven, not asserted, and the first attempt at the proof was wrong.* Cloning
then `git checkout HEAD~1` showed 0 CRLF and looked like a pass; it was
meaningless, because `checkout` only rewrites files that differ between the two
commits and everything except `.gitattributes` is identical. Redone with
`--no-checkout` so the first materialisation happens at the commit under test:

| simulated Windows clone (`core.autocrlf=true`) | text files with CRLF |
| --- | --- |
| commit **before** `.gitattributes` | **138 of 142** |
| commit **with** `.gitattributes` | **0 of 143** |

Both directions hold: a CRLF file staged is stored as LF, and an existing file
rewritten wholesale to CRLF now produces **no diff at all** — the exact failure
that blocked the pull.

**`node_modules` was a Windows install**, `@esbuild/win32-x64` where Linux needs
`@esbuild/linux-x64`, so `tsx`, `vite` and every build script failed. `tsc`
passed throughout, because it is pure JS — which is exactly why a green
typecheck hid it. `npm ci` fixed it in 12s. **One checkout across two OSes needs
one `npm ci` per OS; there is no arrangement that serves both.**

**The dependency audit: 29 advisories, and the dependencies-vs-devDependencies
split is the wrong lens.** `npm ls --omit=dev` says only `builder-util-runtime`
is in the production tree. That view is incomplete: `electron` is a
devDependency whose *runtime ships inside the app*, and `app-builder-lib` is a
devDependency that *builds the AppImage users install*. 26 of 29 reach nobody.

- **Actioned:** GHSA-7g7r-gx96-252g, CWE-427 uncontrolled search path in the
  AppImage produced by `app-builder-lib <26.15.0` (CVSS 7.8). Fixed by moving
  `electron-builder` 26.8.1 -> 26.15.3 *within* the existing `^26.8.1` range, so
  package.json is untouched and only the lockfile moves. Took 10 of the 29 with
  it; 29 -> 19.
- **False alarm:** `builder-util-runtime` is flagged because a vulnerable 9.5.1
  was hoisted for electron-builder. The copy nested under `electron-updater` —
  the one that ships — was already 9.7.0, above the advisory range. Confirmed by
  extracting the packaged `app.asar`, which also proved production
  `node_modules` really are packaged.
- **Deferred:** `electron` 41.7.1 -> 41.10.7. Two advisories, one high (CVSS
  7.2, sandboxed iframe bypasses `allow-popups`) that is realistically reachable
  because this app navigates hidden `BrowserWindow`s to arbitrary streaming
  sites. npm calls the fix semver-compatible and it is *by version*, but every
  patched 41.x declares `engines.node >=22.12.0`. Taking it means moving the
  whole toolchain — local plus five `node-version` entries across two workflows
  — off Node 20. A separate, deliberate decision.
- **Declined:** the vitest/vite/esbuild/happy-dom family (8 advisories, all
  major-version fixes, all test-runner-only, none processing untrusted input),
  and `npm audit fix` even without `--force` — measured at **+122 packages, -7**
  for dev-only issues, which is tree restructuring, not a minimal fix.

**The electron-builder bump nearly shipped a broken release, and only running
the real packaging caught it.** `app-builder-lib >=26.14.0` depends on
`@noble/hashes ^2`, which is **ESM-only**, and its own CommonJS `blockmap.js`
`require()`s it. On Node 20.18.1 that throws `ERR_REQUIRE_ESM` and
electron-builder dies before packaging anything. No electron-builder version
carries the AppImage fix and avoids it. It works from **Node 20.19.0**, where
`require(esm)` was backported — which is why `@noble/hashes` declares
`>=20.19.0`. CI resolves `node-version: '20'` to **v20.20.2**, so the release
pipeline was never at risk; verified by packaging end to end on 20.20.2 (exit 0,
624 MB `linux-unpacked`). **typecheck, lint, tests and e2e were all green while
the packaging step was fatally broken.**

**`Screenshots/` is committed now** — the eight the site uses. It was untracked
on the reasoning that 11 MB of binaries to regenerate 0.8 MB of assets is a bad
trade, and that held right up until it made `optimize-screenshots.ts` runnable
on exactly one machine. `live capture.png` (a 551x148 toast crop, 3:2 frame
would upscale it ~3x) and `unsupported links.png` (an engine error; a red ERROR
block should not lead a landing page) were deleted rather than left unused.
Regenerating from the eight reproduces `docs/assets/screenshots/` byte for byte
and leaves `docs/index.html` unchanged.

**Two mistakes worth recording, both caught by checking rather than by luck.**
`npx asar extract-file` writes to the *current directory* by basename, so it
overwrote the project's `package.json` with `builder-util-runtime`'s; `git
status` caught it and HEAD restored it exactly. And the first `.gitattributes`
proof was invalid, as above.

### Session 19 — the site made responsive, and the carousel stopped calculating

No version bump, **nothing released**. Site only; no app code touched. A
read-only audit first (published at
https://claude.ai/code/artifact/69ec4646-435e-40bf-b8a7-b6279eedd164), then the
implementation. Four files: the template, its generated output, `build-site.ts`
and `verify-engine.ts`.

**The audit measured rather than read.** Playwright across 20 viewports
(300x568 to 3840x2160), a 10px width sweep and an 11-step height sweep. Ten
findings, three high. Overflow was measured against the *viewport*, not
`scrollWidth`, because `body { overflow-x: hidden }` hid it from that check
entirely — which is how the worst bug survived several rounds of responsive work.

**The reported bug: `--shot-limit` never subtracted the sticky nav.** It took
`100svh` minus the section's own furniture, but the section renders *under* a
~75px sticky nav and is anchored with `scroll-margin-top`. So it was reliably
one nav-height too tall. At 1440 wide it only fitted at a viewport height of
**864 or more**; on Isaac's 1440x664 the progress dots sat 106px below the fold
and the caption was cut mid-sentence. Two more defects compounded it: the
`max(340px, …)` floor **overrode** the height cap once the height term fell
below it — the protection disabled exactly when needed, so a landscape phone
overflowed by 135–163px — and `--shot-furniture` was a per-breakpoint constant
(322/330/370) that did not match the measured furniture (289/275/312).

**The fix stops calculating.** The section is a flex column; label, title,
caption and progress are `flex: 0 0 auto`, and only the stage gives ground. The
browser measures the furniture — exactly, at any width, however the caption has
wrapped — so there is no constant left to drift. `--shots-avail` is
`100svh - var(--nav-h) - 1rem` and only ever *caps*; the section's natural
height comes from the slide's width-derived size, so on a roomy screen it takes
what it needs and no more (45% of a 4K viewport, 67% of 1440p, 85% of 1440x900).

Two details made that possible. **`--nav-h` is a definition, not an estimate**:
`nav` is built from it and every child is capped at `--nav-line`, so the value
the carousel subtracts is exactly what the bar occupies. And **the step is a
percentage** — `translateX(60%)` resolves against the element's own border-box
width — so with the slide's width derived from its height through
`aspect-ratio`, the gap between neighbours tracks the slide with no width
variable at all. That is what removed the last constant. Measured at exactly
60.0%. The slide constrains **one** dimension only (`height: 100%; width: auto`);
constraining both is what would squash the frame.

**Result: 18 of 20 viewports show the whole section — label, title, caption and
progress — without scrolling.** The two that don't are landscape phones
(740x360, 844x390), where the furniture alone is ~195px of a ~300px usable
height; the page scrolls and nothing is clipped, which is the honest outcome.
The floor is 24rem, set from the measured worst case (furniture 195–244px plus
the stage's 6rem minimum), and verified not to overlap the next section at eight
extreme-short viewports.

**The nav CTA was clipped below 390px — and again from 424 to 448px.** The row's
intrinsic width was a fixed 383px, and with `overflow-x: hidden` the Download
button could not even be scrolled to; at 320px it rendered as "Dow". The second
band appeared when `.nav-badge` un-hid above its 420px breakpoint and pushed the
row to 448px — **a band no spot check would find**, since the fix before it was
verified at 320 and 820. Now fluid throughout, mobile-first (badge and links
start hidden and are turned *on* by width), with `min-width: 0` as the safety
net. **A separate 48px was being wasted by the hidden links themselves**:
`display: none` on the `<a>` leaves four zero-width `<li>` behind and each still
takes a flex gap. Hiding `li:has(> .text-link)` recovered it, and the wordmark
stops truncating down to 300px.

**Also fixed:** the hero was a constant 837px at every width ≥1280 whatever the
viewport height, putting its Download button below the fold on 1440x664 and
1280x720 — every vertical value is now clamp()'d with a vh term.
`#requirements` was the one anchor with no scroll margin (session 17 fixed the
identical bug for `#download`); it is now a single `section[id]` rule so a new
section cannot miss it. The layout froze at ~1290px — every measurement was
byte-identical at 1680/1920/2560/3440/3840 — so five content max-widths became
two shared tokens that line up, nav and footer centre their contents inside
`--shell-max` via `padding-inline: max(gutter, (100% - max) / 2)` instead of
stranding them at opposite corners, and type and section padding keep growing.
`scroll-behavior: smooth` now honours `prefers-reduced-motion`.

**Breakpoints are content-driven and mobile-first.** Six `max-width` queries
became three `min-width` ones plus one `max-height`, each at a width where the
content genuinely changes: 26.5rem (the badge fits), 45rem (room for the outer
slide pair and the arrows), 52rem (the nav links fit), and a short-viewport tier
that trims the carousel's type. The `req-grid` and both card grids use
`minmax(min(Nrem, 100%), 1fr)` and collapse on their own — the `min()` is what
lets a single column go narrower than the track floor, which the download grid
previously could not. `.card` and `.feature` are **container queries**: a card
in an auto-fit grid can be 280px or 500px at the same viewport width, so what it
needs to know is its own size.

**`body { overflow-x: hidden }` is gone.** It never prevented the overflow it
was hiding — it made the clipped CTA unreachable instead of scrollable. Long
tokens are handled where they occur (`overflow-wrap: anywhere` on changelog and
requirements code). **96 widths from 280 to 3840 now measure zero overflow with
no masking rule in place.**

**Verification**: typecheck, ESLint 0/0, 207 tests, `verify:engine` **268
checks**, Playwright 12/12, production build. Plus 13 behavioural assertions
driving the real carousel (autoplay, side-slide click, arrows, a **real** mouse
swipe, phone peek, reduced motion, served-equals-rendered) and the 20-viewport
matrix re-run. All four new guards were confirmed red against their bug: the
missing `--nav-h`, a width-only `--shot-w`, a width-constrained slide, and a
removed cap.

## Working agreements for future sessions on this repo

- **Let the browser do the layout arithmetic.** Two carousel regressions came
  from computing a height in CSS: first width-only, then `100svh` minus a
  hardcoded furniture constant that never subtracted the sticky nav. A flex
  column with `flex: 0 0 auto` furniture and a shrinking stage measures the
  furniture exactly, at every width, and leaves no constant to drift.
- **A `max()` floor cancels the `min()` cap above it.** `max(340px, min(…,
  heightTerm))` disables the height protection precisely when the window is too
  short — which is the only time it was needed. A floor and a cap cannot both
  be hard limits; decide which one may be violated.
- **A percentage in `translateX` resolves against the element's own width.**
  That is how the carousel's step tracks a slide whose width is derived from
  its height, with no width variable anywhere. Reach for it before adding a
  custom property that has to be restated at every breakpoint.
- **Constrain one dimension, never two.** `height: 100%` + `width: auto` +
  `aspect-ratio` cannot distort. Adding a `max-width` to that re-breaks the
  frame, because the ratio loses to two definite dimensions.
- **A reserved height must be a definition, not an estimate.** `--nav-h` is
  what `nav` is built from and every child is capped to it, so anything
  subtracting it is exactly right. An estimate of a component's height drifts
  from it the first time its padding changes.
- **`display: none` on a link leaves its `<li>` taking a flex gap.** Four
  hidden nav links were costing 48px of nothing — a sixth of a small phone.
  Hide the list item (`li:has(> .text-link)`), not the anchor.
- **`overflow-x: hidden` hides the bug, not the overflow.** It made a clipped
  Download button unreachable rather than scrollable, and kept it out of every
  `scrollWidth` check. Remove it, fix what actually overflows, and let a
  regression show itself.
- **Mobile-first turns a "hidden below X" rule into "shown above X".** The nav
  badge was hidden under 420px, so at 421px it reappeared into a row that could
  not hold it and clipped the CTA — a 424–448px band nobody would look at.
  Starting hidden and enabling by width cannot produce that shape.
- **One checkout, two operating systems, two `node_modules`.** A Windows
  install leaves `@esbuild/win32-x64` where Linux needs `@esbuild/linux-x64`;
  every build script dies and `tsc` still passes, because it is pure JS. Run
  `npm ci` after switching OS, and never try to make one tree serve both.
- **An exactly-equal insertion and deletion count is a line-ending change.**
  9097/9097 across 30 files named the cause before a single file was opened.
  Confirm with `git diff --ignore-cr-at-eol`, then reset without fear.
- **Prove a checkout-behaviour fix with `--no-checkout`.** Cloning and then
  `git checkout HEAD~1` only rewrites files that *differ* between the commits,
  so the control shows a pass and proves nothing. The first materialisation has
  to happen at the commit under test.
- **"Dev dependency" is not "cannot reach a user".** `electron`'s runtime ships
  inside the app and `app-builder-lib` builds the installer users run — both are
  devDependencies. Ask what lands on a user's disk, not which section of
  package.json a package sits in.
- **A semver-compatible fix is not automatically a safe fix.** The in-range
  electron-builder bump pulled an ESM-only `@noble/hashes` that its own
  CommonJS code `require()`s, killing packaging on Node 20.18. typecheck, lint,
  tests and e2e were all green. Run the real build after any dependency change.
- **"No horizontal overflow" is not "it fits".** The carousel was checked for
  horizontal overflow at three widths and passed every time while being 961px
  tall on a 664px screen. Assert the section's height against the viewport's,
  and test a short viewport — a laptop with a bookmarks bar has far less height
  than a maximised test window.
- **Size by both axes when a component's height follows from its width.** An
  aspect-ratio box driven by `min(Nvw, Npx)` ignores the viewport height
  entirely. Adding the height-derived term to the same `min()` costs one line
  and cannot be forgotten at a breakpoint.
- **Tuning a responsive fix at one width proves it at one width.** The nav
  overflow was fixed and verified at 820px, and still overflowed at 768px.
  Sweep a range.
- **A synthetic event cannot reproduce a native browser gesture.** A swipe test
  built on dispatched `PointerEvent`s passed against a carousel whose mouse
  swipe was completely broken: Chromium's native image drag ate the gesture,
  and dispatched events never start native drag-and-drop. Drive the real input
  (Playwright's `mouse`/`touchscreen`, or CDP touch events) for anything that
  competes with a browser default.
- **`<img>` is a drag source, and that swallows the pointer sequence.** Session
  4 hit it on the wallpaper button, session 17 on the carousel slides. Any
  drag-, swipe- or click-on-image interaction needs `draggable="false"` and a
  cancelled `dragstart`.
- **Pause on `:focus-visible`, not on focus.** A mouse click leaves DOM focus on
  the button it hit, so "pause while focused" meant a carousel that stopped
  forever the first time someone clicked a dot.
- **A timer that also draws the progress bar cannot drift from it.** The
  carousel's fill is the elapsed hold rendered, not a parallel animation, so a
  manual jump resets both by resetting one number. Two mechanisms answering
  "how far through are we" is the same shape as the two error classifiers and
  the four language classifiers this file already records.
- **A guard that can match prose is not guarding code.** "The carousel script
  names no screenshot" tripped on the word *capture* inside a comment about
  pointer capture, and then passed wrongly because its regex anchored on a
  string that appears first in the stylesheet. Strip comments, and anchor on
  code that only the thing you mean can contain.
- **Measure overflow, don't look at it.** A fifth nav link pushed the Download
  button off the right edge only between 721px and ~900px, where nothing was
  being screenshotted. `document.documentElement.scrollWidth` against
  `clientWidth` found it in one line.
- **Serve the end state, don't let JS correct it on load.** Slides shipped
  parked off-stage and repositioned by script animate across the page on first
  paint, because the transition fires on the correction. Generate the same
  state the script would compute, and assert the two agree.
- **An ignore rule enforces what documentation can only request.** HANDOVER said
  `.claude/launch.json` "must stay untracked"; nothing stopped anyone adding it,
  and the same directory holds whole worktree checkouts. If a note asks a human
  to remember something git can enforce, make git enforce it.
- **A helper that looks like the duplicate you are about to merge may differ in
  its fallback.** `release-notes.ts` imported `entryForVersion` and used an
  inline `.find()` instead. The helper falls back to the newest entry — merging
  them would have attached the *previous* release's notes to a new release.
  Read the branch you are deleting, not just the signature.
- **Excluding code from a report is how a number stops meaning anything.**
  Coverage excluded `electron/**` while two thirds of the suites tested it, and
  counted the test files themselves. Three exclusions fixed, and the figure went
  from decorative to interpretable — a lower honest number beats a flattering one.
- **Code nothing lints will drift.** All 14 files in `scripts/` were outside the
  ESLint scope, including the ones that decide whether a release ships working
  engines. That is where `download-plugins.ts` quietly went out of step with a
  layout change and would have reintroduced a fixed user-facing bug.
- **A script with no caller is a script nobody has run.** Reading
  `download-plugins.ts` found the wrong plugin root; *running* it found that it
  had never worked on Linux at all (GNU tar cannot open a zip) and that one
  upstream repo has been deleted, leaving our vendored copy the only one. A
  script that writes to the repo can be run safely against a scratch `cwd`.
- **Carry a fix across every script that shares the bug.** Session 4 fixed bare
  `tar` in `download-binaries.ts`; `download-plugins.ts` had the same line, was
  never touched, and stayed broken until session 16 ran it. Same shape as the
  referer fix landing on the probe but not the extractor — grep for the pattern,
  not the file you were already reading.
- **An error message names a symptom, not a cause.** yt-dlp reports every 403
  from a Cloudflare-fronted host as an anti-bot challenge. Four sessions treated
  that as the diagnosis; the actual cause was a wrong `Referer`, and one matrix
  of eight requests found it. Test the claim the message makes.
- **Fix every route into the branch, in the same change.** The referer fix
  landed on the probe and not the extractor, so single episodes worked and
  ranges kept failing — the same shape as session 8's folderHint miss. Grep for
  the pattern, not the call site you happen to be reading.
- **A timeout that awaits something unbounded is not a timeout.**
  `executeJavaScript` never settles against a hung renderer, so the 45s deadline
  hung inside its own last-resort branch and logged nothing. Every rescue path
  needs a deadline of its own.
- **Stale output masks the fix under test.** Five "completed" downloads had
  fetched nothing — `--no-overwrites` skipped them all. Check timestamps and
  content, not the status badge, before concluding a change worked.
- **Short-lived tokens rule out pre-resolving a batch.** These manifest URLs die
  in about 90 seconds. Any design that resolves links for a whole range up front
  produces links that are already dead; carry the *choice* forward and resolve
  each item at its turn.
- **Count the copies before you merge them.** The handover recorded two language
  classifiers; `stream-options-probe.ts` alone held four, and a `verify-engine`
  guard written against the *symptom* (`includes('en')` appearing anywhere in
  the file) is what surfaced the third and fourth. Grep for the defect, not for
  the function name you already know about.
- **A tool's stars and last-commit date say nothing about whether it works.**
  `ani-cli` is 13.7k stars, was pushed three days before session 14 looked at
  it, and is entirely non-functional because its single backend is serving a
  maintenance page. One curl answered what the README could not.
- **Check the licence before reading another project for answers.** Verified per
  repo, not inherited from notes: all three anime CLIs are GPL-3.0 and
  StreamDock is MIT. Facts about providers are free to use; their code is not.
  Clone them outside the repo so it cannot happen by accident.
- **Wiring that exists is not a feature that works.** The plugin system had
  every piece in place — packages present, args passed, files packaged — and had
  never once loaded in any shipped build. Session 13's audit marked it working
  from the code alone; one `-v` run against the real binary disproved it in
  seconds. Run the thing.
- **Test the artifact CI produced, not one you built.** `gh run download` gives
  the exact bytes a user gets. Session 12 verified Linux this way; a local build
  would not have proved the CI job packages real engines.
- **An icon that exists is not an icon the desktop can find.** Ask the theme:
  `Gtk.IconTheme.lookup_icon(name, 48)`. A 1024x1024 PNG is outside hicolor's
  index and resolves to nothing, which no file-existence check would catch.
- **electron-builder downsamples icons for macOS and Windows but not Linux.**
  Linux gets exactly the sizes you hand it. Point `build.linux.icon` at a
  directory of indexed sizes, never at a single large PNG.
- **A blocked resource is not a missing resource.** A broken-image glyph means
  the src was set and the load failed; a missing value renders the placeholder
  instead. Session 12's thumbnails were correct in the data and blocked by CSP —
  check the policy before re-plumbing the value.
- **When a fix has two routes into the bad branch, fix both.** Session 8 closed
  the folderHint route to the folder branch; the playlistItems route stayed open
  and produced the same "NA" folder four sessions later.
- **A green build is not a working artifact.** CI's Build Linux job passed for
  months while packaging an app with no engines in it, because the download
  script exited 0 without downloading. Assert on the artifact's contents, not on
  the step's exit code.
- **Verify upstream asset names against the API before hardcoding them.** Two
  sessions have now been spent on URLs that looked right: `releases/latest/`
  vs the `latest` tag, and the plain `yt-dlp` asset vs `yt-dlp_linux`.
- **Truncated text in a rendered page is not automatically a CSS bug.** Check
  the generated HTML first: if the text is not in the source, no stylesheet did
  it. Session 10's cuts landed exactly on markdown line breaks, which named the
  culprit before any CSS was read.
- **Two copies of a parser will drift, and only one of them gets fixed.** The
  site and the README rendered the same changelog through different code; the
  README was correct for months while the site silently truncated.
- **"It's not automated" and "the automation never ran" are different bugs.**
  Session 9's release drift looked like a missing pipeline; the pipeline existed
  and worked. What was missing was the manual step that triggered it. Check
  whether the machinery ran before rebuilding it.
- **A trigger that depends on a human step is not automation.** If a pipeline
  starts from something a person must remember to do, it will drift. Make the
  artifact (the tag) an output of the pipeline, not its precondition.
- **Read `%APPDATA%/streamdock/streamdock.log` before theorising.** It carries
  real spawn command lines and verbatim yt-dlp stderr from Isaac's own runs.
  Session 8 found the exact overwrite behind a mislabelled error by grepping two
  adjacent lines of it.
- **A user-supplied root cause is a lead, not a finding.** Round 4 named
  "batching into groups of 100" as the cause of episode overshoot; no batching
  code existed. The real cause was a 200-entry generator and a hardcoded 999.
  The report was still right that something was wrong — verify the symptom, and
  treat the explanation as a hypothesis.
- **Check timestamps before re-fixing a "still broken" report.** Session 8's P5
  was a bug that had been fixed four minutes after the run being reported.
  Comparing `git log` dates against the app's own startup log settled it in one
  command, and avoided a second wrong guess at the same code.
- **When two code paths answer the same question, the last one wins.** The
  mislabelled error had a correct classifier and a context-free one; only the
  context-free answer ever reached the UI. Prefer one function that takes
  context over two functions that happen to agree today.
- **A regression test that has never failed against the bug is not a test yet.**
  Revert the fix, watch it go red, restore. Session 8's first clipboard test
  passed against the broken code because the symptom only appears on the next
  React render.
- **Never write to a controlled React input's DOM node.** Setting `.value` and
  firing a synthetic event also updates React's value tracker, so the change is
  invisible to React and is undone by the next render. Pass the value as state.
- **Never inherit a failure diagnosis you haven't reproduced.** This file
  asserted for four sessions that the two red CI jobs needed binaries and a
  display. Neither did. One local run of `npm run verify:engine` in session 7
  produced the real cause in seconds.
- **A duplicated-looking UI element is often one element from an unexpected
  layer.** Session 6's second "StreamDock" was a native menu label, and its
  duplicate sidebar icon was a nav component reused as a logo — neither was
  where the markup suggested. Check what else renders into that row first.
- **Reproduce before diagnosing.** Session 5's "rate limited" report was a
  mislabel of a stale-engine 403, and no amount of reading the retry logic
  would have shown that. Running the engine's exact spawn arguments standalone,
  and diffing old binary against new, settled it in minutes.
- **Verify before fixing.** Both sessions found that written task specs
  (a general request, and a detailed `Task.md`) contained claims that didn't
  match the actual code. Read the real file before treating a bug report as
  ground truth — this saved real time and avoided speculative rewrites in
  session 2.
- **Always run the full pipeline before calling something done**:
  `npm run typecheck`, `eslint .`, `npm test`, `npm run build:app`. Don't ship
  based on inspection alone — session 1 found four production bugs specifically
  *because* the test suite was fixed and could actually run.
- Keep this file updated at the end of a work session: what changed, what's
  still open, what's confirmed vs. suspected. The commit messages have the
  full technical detail; this file is the fast-orientation summary.

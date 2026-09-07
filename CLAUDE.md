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
- Tests: Vitest (`*.test.ts`/`*.test.tsx`, jsdom/happy-dom) + Playwright e2e
  (`tests/e2e/`). The e2e specs load the renderer over HTTP and assert on the
  DOM, so they are browser tests: no Electron, no binaries, no display needed.
  Session 7 corrected a long-standing claim to the contrary.

Key scripts: `npm run typecheck` (two tsconfig projects — renderer and
electron, run both), `npm run lint` region is actually just `eslint .`
(flat config, `eslint.config.js`, zero-warning gate), `npm test` (Vitest),
`npm run build:app` (production build without packaging), `npm run
verify:engine` (a pure static/unit check — no binaries, no network),
`npx playwright test` (e2e).

**Diagnosing a real user-reported failure? Start here:**
`%APPDATA%/streamdock/streamdock.log` is `electron-log`'s output from Isaac's
actual runs — full yt-dlp spawn command lines, verbatim stderr, timestamps.
`logs/main.log` beside it only records version banners.

## Where things stand (as of this session)

Nine work sessions have happened against this repo so far.

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

## Working agreements for future sessions on this repo

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

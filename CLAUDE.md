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
  (not exercised by either session below — needs real yt-dlp/ffmpeg + a
  display, likely not runnable in a headless sandbox).

Key scripts: `npm run typecheck` (two tsconfig projects — renderer and
electron, run both), `npm run lint` region is actually just `eslint .`
(flat config, `eslint.config.js`, zero-warning gate), `npm test` (Vitest),
`npm run build:app` (production build without packaging), `npm run
verify:engine` (not yet exercised by any session so far).

## Where things stand (as of this session)

Three work sessions have happened against this repo so far. Sessions 1 and 2
were fully verified (typecheck clean × 2 projects, ESLint 0/0, Vitest passing,
production build succeeds) but left their work **uncommitted** in the working
tree — session 3 was the one that actually committed, pushed, tagged, and
released it. See session 3 below for what's now actually live.

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
- **`npm run verify:engine` and the Playwright e2e suite have never been run**
  by any session so far — e2e needs real yt-dlp/ffmpeg binaries and a display,
  which this sandboxed environment likely can't provide.
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

## Working agreements for future sessions on this repo

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

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

Two work sessions have happened against this repo so far, both fully verified
(typecheck clean × 2 projects, ESLint 0/0, Vitest passing, production build
succeeds) and both delivered live to `D:\PROJECTS\StreamDock` — not just
sitting in a sandbox.

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

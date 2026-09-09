# Handover — next session

Written at the end of session 20 (2026-09-09). Version **1.7.0**, released.

`CLAUDE.md` is the long history and the working agreements — read it first.
This file is only what the *next* session should pick up, and why.

---

## 0a. FIRST, IF YOU SWITCHED OPERATING SYSTEM

The repo is on a drive both operating systems write to. One command follows
from that, and skipping it will stop you dead:

```
npm ci
```

**`node_modules` is currently a WINDOWS install** (session 20 regenerated it).
It holds `@esbuild/win32-x64`, so **the next Linux boot must run `npm ci`
before anything else.** The reverse was true when session 18 wrote this file;
the direction flips every time the OS does. One `npm ci` per OS switch, every
time. There is no arrangement that serves both.

**The failure is worse than a wrong native binary, and worth recognising fast.**
A Linux `npm ci` writes `node_modules/.bin` as symlinks, not the `.cmd` wrappers
Windows needs — session 20 found 58 entries and **zero `.cmd` shims**. So nothing
resolves at all:

```
'tsc' is not recognized as an internal or external command
'tsx' is not recognized as an internal or external command
```

`typecheck`, `lint`, `test`, `verify:engine`, `build` and every `scripts/` entry
point are dead until `npm ci` runs. Note that on the *Linux* side the same
mistake presents differently — there `tsc` keeps passing, because it is pure JS.
**A green typecheck is not evidence the toolchain works, on either OS.**

**Node must be 20.19.0 or newer.** `npm run build` (electron-builder 26.15.3)
needs `require(esm)`, which landed in Node 20.19. CI uses v20.20.2. The Linux
side is on 20.18.1 and therefore *cannot* package locally; **this Windows box is
on v24.19.0** and packages fine. Anything at 20.19+ works — this is not a Node
22 requirement.

**`package.json` now declares `engines.node: ">=20.19.0"`** (session 20). It
encodes the one proven constraint — electron-builder needs `require(esm)` — so
the Ubuntu box's Node 20.18.1 now earns an `EBADENGINE` warning that explains
why packaging fails there. It is a warning, not a gate: there is no `.npmrc` and
`engine-strict` is false, so CI is unaffected.

**The `engines` floor and CI's `node-version: '20'` pin (eight places across
ci.yml and release.yml) must be revisited together — not separately — once the
Electron 41.10.7 bump lands** (item 0 in section 5). That bump requires
`>=22.12.0`, which moves the floor, the CI pin, and the toolchain that builds
real installers all at once. Changing the pin on its own decides half of a
question whose other half is a security upgrade. Local Node here is v24.19.0, a
major ahead of CI; everything passes on both today.

**npm 11 prints an `allow-scripts` warning** naming `electron`, `esbuild` and
`electron-winstaller`. It is advisory in 11.17.0, not a block: session 20 checked
that `node_modules/electron/dist` really is created during the install and that
`npx electron --version` returns v41.7.1. If npm later makes blocking the
default, a fresh `npm ci` would silently skip Electron's 213 MB download and
`npm run dev` would fail with no obvious cause — an install that *looks* clean
and an app that will not start.

**Until that is addressed properly, sanity-check it after any `npm ci`:**

```
ls node_modules/electron/dist/electron.exe   # or .../dist/electron on Linux
npx electron --version                       # expect v41.7.1
```

If the directory is missing, the postinstall was skipped rather than failed —
`npm approve-scripts` is the escape hatch, and nothing else about the install
will look wrong.

**Line endings are handled** (`.gitattributes`, `* text=auto eol=lf`, added
session 18). Session 20 confirmed it holds under real Windows use: this machine
has `core.autocrlf=true` — the exact setting behind session 18's 9097/9097
incident — and after a full install plus every file-writing generator, **139 of
139 tracked text files were still LF and 0 files were modified.** The attribute
overrides autocrlf, so do not "fix" the git config; the file is the enforcement,
and changing the config would only hide whether it still works.

Everything is pushed. `main` is the only branch, local and remote, and the
working tree was clean at the end of session 20.

---

## 0. Where things stand

v1.7.0 is published, and the site now carries a screenshots carousel (sessions
17-18) sized so the whole section fits a laptop viewport. Dubbed downloads work,
including across an episode range, and every content choice has a single home in
the UI. Isaac confirmed dub on episodes 1 and 2 of Bleach through the real app.

**Sessions 17-20 were site, infrastructure and environment only — no app code
changed.** Session 19 made the whole site responsive and stopped the carousel
calculating its own height (it is a flex column now, so the browser measures the
furniture); session 20 repaired the Windows toolchain. The last change to
`electron/` or `client/src/` was session 15.

Baseline: **207 tests, 268 engine checks, Playwright 12/12, ESLint 0/0.**
Confirmed green on Windows (Node v24.19.0) at the end of session 20, from a
fresh `npm ci`, including a real electron-builder package.

Anikoto is now genuinely working end to end — series listing, real episode
counts, per-episode language selection, and downloads that complete. That was
the single biggest open item across the last several sessions.

---

## 1. Known limits, worth knowing before picking work

- **Only anikoto is proven.** `reanime.to`, `animex.one` and `rivestream.app`
  are still absent from `host-config.json`; `rivestream.app` did not resolve at
  all from this network. `shuttletv.su` is a Next.js app whose HTML carries
  nothing useful — it needs the browser path.
- **The dub is verified as a distinct stream, not by ear.** The site labels the
  server `data-type="dub"` and it is a different encode with different audio.
  Nobody has confirmed the spoken language by listening.
- **The language switcher's selectors are still broad.** On anikoto they also
  match a "Contribute" button and a "360p720p1080p" quality row. Those are
  dropped because the declared `data-type` options win, but a site without
  `data-type` would still surface them.
- ~~**`tsbuildinfo` files are committed**~~ — fixed in session 16: `*.tsbuildinfo`
  is ignored and both files are untracked.
- **`.claude/launch.json` must stay untracked** — it holds an absolute Linux path
  to a user-local Node. Isaac dual-boots. Session 16 added `.claude/` to
  `.gitignore`, so this is now enforced rather than merely asked for; that
  directory also holds git worktrees, which must never be committed either.

---

## 2. The reference-project question is answered — don't reopen it

Session 14 evaluated `anipy-cli` and `ani-cli` as the previous handover asked.
Full write-up:
https://claude.ai/code/artifact/1e3136ea-3954-4808-8498-584f840951af

**Neither is worth adopting.** Zero host overlap with StreamDock, and none of
Isaac's failing samples. Measured live: `anidb.app` serves an "Under
Maintenance" page and is `ani-cli`'s *only* backend; `animekai.to` is
unreachable with a 404 decoder feed. Their designs were taken (tri-state
language, headless HTTP); their code and backends were not, and should not be —
all three are GPL-3.0 against StreamDock's MIT.

Do not spend another session re-surveying them.

---

## 3. The anikoto embed question — now moot, kept for the record

**No longer worth doing.** Session 15 made anikoto work through the hidden
BrowserWindow extractor instead — the 403 that made this look necessary was a
wrong `Referer`, not a broken plugin. The bundled yt-dlp plugin is still stale
for this host, and that no longer matters because nothing depends on it.

Kept here only so a future session does not rediscover it and assume it is the
way in. The analysis below is accurate; it is just not the cheapest route any
more.

StreamDock's bundled plugin works as far as the embed. Confirmed by running it:

```
[anikoto] MTF1d: Downloading stream server          ← catalogue layer works
[anikoto] Extracting URL: https://vidtube.site/stream/WGtqT3hpNE51…/sub
ERROR: 'NoneType' object has no attribute 'group'
```

The embed extractor in `plugins/anikoto/yt_dlp_plugins/extractor/anikoto.py`
gates on:

```python
_VALID_URL = r'https?://(?:vidwish|megaplay)\.(?:buzz|live)/stream/s-2/(?P<id>[^/]+)/(?:h?sub|dub)…'
```

`vidtube.site` matches neither the host alternation nor the `/s-2/` segment, so
nothing claims the URL. **This is a pattern coverage gap, not "markup drift"** —
the recorded diagnosis was wrong. The extractor body is host-agnostic (it
derives `base_url` from whatever URL it is handed), so the pattern is the only
blocker.

**The measurement to take first:** resolve one live `vidtube.site` embed by
hand — fetch the embed page, pull `data-id`, then
`GET <base>/stream/getSources?id=<data-id>` with `Referer` set to the embed URL.

- If `sources` come back **plaintext**, widening `_VALID_URL` is very likely the
  whole fix. Add a regression test and be done.
- If they come back under an encrypted **`enc`** field, stop — the regex is not
  the answer and section 3 is. The equivalent `megaplay.buzz` embed *did* return
  `enc` when session 14 checked, along with plaintext subtitle tracks and
  intro/outro markers, so this is the likelier outcome. `ani-cli-rs` has no
  decryption at all and fails the same way.

If someone does pick this up, do not promise it as a one-liner before taking
that measurement — and weigh it against the fact that the browser path already
works.

---

## 4. The anikoto JSON API (already used for episode counts)

`anikotoapi.site` responds 200 and **self-declares the domains it serves**:

```json
{"ok":true,"anikoto_domains":["anikototv.to","anikoto.cz"], "data":{...}}
```

`/series/{id}` returns real title, `poster`, `mal_id`, `ani_id`, `is_sub` /
`is_dub` counts, and per episode:

```json
{"id":129789,"title":"Episode 1","number":1,"episode_embed_id":"162413",
 "embed_url":{"sub":"https://megaplay.buzz/stream/s-2/162413/sub"}}
```

The series slug (`does-it-count-…-android-tp6cx`) has the same shape as the one
in Isaac's URLs (`one-piece-odmau`), so a pasted watch URL maps straight onto
this API. That would give anikoto real titles, thumbnails, honest episode counts
and genuine sub/dub availability **with no markup scraping and no browser** —
several open items at once, and testable in CI.

Session 15 already uses this for episode counts — the `data-id` on an episode
page keys `/series/{id}`, which is how One Piece reports 1177 episodes instead
of 1. The remaining unused parts are titles, posters and per-language counts.
It is anikoto's own backend, not a third party: it self-declares the domains
above.

---

## 5. Still open, in rough value order

0. **Decide on Electron 41.7.1 -> 41.10.7, which means deciding on Node 22.**
   The only outstanding advisory that reaches users. Two of them, one high
   (GHSA-9f4c-93c8-jc8g, CVSS 7.2 — a sandboxed iframe bypasses the
   `allow-popups` restriction), and it is realistically reachable *here*
   specifically because the app navigates hidden `BrowserWindow`s to arbitrary
   streaming sites for manifest extraction. npm calls the fix semver-compatible
   and by version it is, but **every patched 41.x declares
   `engines.node >=22.12.0`**, so taking it means moving local Node plus five
   `node-version: '20'` entries across ci.yml and release.yml. The risk is not
   Electron: it is that Node 22 also runs esbuild, vite, vitest and
   electron-builder in the pipeline that produces the real installers. Do it as
   its own change, verify by watching the Build jobs, not as a dependency bump.
   Everything else in the audit is dev-only; see session 18 in CLAUDE.md for why
   each was declined.

1. **Per-item quality detection for playlists.** `qualityOptions` is only
   populated when the probe resolved a single item, so a playlist reports none.
   Confirmed live: the YouTube playlist fixture returns `qualities: NONE`. Bound
   and cancel it — a 366-episode series must not block the UI.
2. **Five request fields are sent and never read** by the engine:
   `selectedAudioFormatId`, `selectedAudioManifestUrl`,
   `selectedSubtitleFormatIds`, `selectedSubtitleManifestUrls`, and the modal's
   displayed `resolvedFormat`. Either consume them or remove the per-track UI.
   Two subtitle tracks in one language are still indistinguishable.
3. **mkv container choice.** `--merge-output-format mp4` is hardcoded. mp4 only
   carries `mov_text`, so embedding an ASS/SSA subtitle silently destroys
   styling, and multi-audio is fragile. This blocks doing 2 properly.
4. **Host coverage for the remaining samples.** `reanime.to`, `animex.one` and
   `rivestream.app` are absent from `host-config.json` entirely.
   `rivestream.app` did not resolve at all from this network. `shuttletv.su` is
   a Next.js app serving nothing useful in its HTML — it needs the browser path.
   Adding a host is now a **config edit**, so the cost here is the extraction,
   not the routing.
5. ~~**`CONTRIBUTING.md` never mentions `npm ci` or the OS switch**~~ — fixed in
   session 20. Its Development section now leads with `npm ci`, states the Node
   20.19 floor and why it exists, and describes both directions of the OS-switch
   failure, so a contributor who never reads this file or `CLAUDE.md` still
   learns it.
6. ~~**The release-window collision**~~ — fixed in session 16, after confirming
   it happened for real on v1.7.0 (Deploy Site published "1.7.0" to the site at
   15:13:37; the installer did not exist until 15:17:03). `CHANGELOG.md` is no
   longer a push path for `deploy-site.yml`.

   **What to watch on the next release**, since none of it could be verified
   without an actual run: that Deploy Site fires *once*, from `workflow_run`
   after Build & Release succeeds — not twice; that ci.yml's
   "Packaged by the release workflow?" job reports `handled=true` and its Build
   Windows/Build Linux jobs show as skipped while Build macOS still runs; and
   that release.yml's new `quality` job passes before anything is packaged.

**What still cannot be tested headlessly, and is exactly what hosts 4 depends
on:** the hidden `BrowserWindow` manifest extractor. It needs a real Electron
session. To move there you need Isaac to run the app against one of these URLs
and share `~/.config/streamdock/streamdock.log` (Linux) or
`%APPDATA%/streamdock/streamdock.log` (Windows). That log carries real spawn
command lines and verbatim stderr and has settled several bugs in one grep.

---

## 6. Environment notes

- **Isaac dual-boots Ubuntu 26.04** and may be on either OS. Sessions 13 and 14
  ran entirely from Linux; session 20 ran from Windows.
- **The Windows box** is Windows 10 Pro on **Node v24.19.0 / npm 11.17.0**, with
  the repo at `D:\PROJECTS\StreamDock`. `binaries/` holds the Windows engine
  set (yt-dlp 2026.08.19, ffmpeg/ffprobe N-126435) and `check:binaries` passes
  there.
- **The npm-install timeouts `CLAUDE.md` records did not reproduce in session
  20.** Two full `npm ci` runs completed in ~2 minutes each, 740 packages, no
  `ENOTEMPTY` and no AV stall. Treat that note as historical rather than a
  standing property of this machine — but it is still the first thing to suspect
  if an install hangs.
- **No system node/npm on the Ubuntu box.** A user-local Node 20 lives at
  `~/.local/node-v20.18.1-linux-x64` — prepend it to `PATH`.
  **That Node is 20.18.1, below the 20.19 floor `npm run build` now needs**, so
  packaging cannot be run from it; everything else (typecheck, lint, tests,
  verify:engine, build:app, e2e) works fine. CI is on v20.20.2.
- **No engine binaries in a fresh worktree** (`binaries/` is gitignored, and the
  main checkout holds Windows `.exe`s). `npm run download:binaries` fetches the
  Linux set; session 14 grabbed `yt-dlp_linux` alone (40MB) for a quick test.
- **The screenshot sources are committed** at `Screenshots/` (capital S) as of
  session 18 — the eight the site uses. `npm run screenshots:build` needs no
  argument and reproduces `docs/assets/screenshots/` byte for byte — **verified
  on Windows too** in session 20 (all 24 WebP files re-encoded through Chromium,
  zero diff), as was `npm run sync:docs`. The generators are genuinely
  platform-neutral: nothing in the tree uses `os.EOL`, every write passes
  explicit `'utf-8'`, and the source path is spelled `join(repoRoot,
  'Screenshots')` with the capital S that case-sensitive Linux requires.
- `gh` is installed and authenticated as `Isaac-Onyango-Dev`.
- Reference clones live in the session scratchpad, outside the repo, on purpose.

---

## 7. Pipeline

Run all of it before calling anything done:

```
npm ci
npm run typecheck && npm run lint && npm test && npm run verify:engine
npx playwright test && npm run build:app
```

`npm ci` leads only when you have just switched OS — see section 0a. Use
`npm run lint`, not a bare `npx eslint .`: session 16 added the script so CI and
humans run the same one command.

Baseline: **207 tests, 268 engine checks, Playwright 12/12, ESLint 0/0.**

The site has its own manual step: `npm run screenshots:build` re-encodes
`Screenshots/` into `docs/assets/screenshots/`. It is not part of any build and
CI never runs it — like `icons:build`, it needs a browser.

**After any dependency change, run the real packaging too**, not just
`build:app`. Session 18's electron-builder bump passed typecheck, lint, tests
and e2e while `electron-builder` itself was fatally broken on the local Node:

```
npm run build:app && npx electron-builder --linux dir --publish never
```

Regenerating `node_modules` for a different OS counts as a dependency change.
Session 20 therefore ran the **full** Windows package —
`npm run build -- --publish never`, the same command and flag release.yml uses —
and it produced a real NSIS installer. Node 24 packages fine; the
`ERR_REQUIRE_ESM` failure session 18 hit was specific to Node 20.18.

---

## 8. Habits this repo earned the hard way

- **A Linux `npm ci` leaves a Windows checkout with no `.bin` shims at all.**
  Not just the wrong native binary — npm writes `node_modules/.bin` as symlinks
  on Linux and `.cmd` wrappers on Windows, so after an OS switch *every* tool
  reports "'tsc' is not recognized" rather than failing at build time. Session 20
  measured 58 entries and 0 `.cmd` files; `npm ci` produced 57 `.cmd` shims.
- **A regression test that has never failed against its bug is not a test yet.**
  Revert the fix, watch it go red, restore. Every fix in session 14 was
  validated this way, including both new `verify-engine` guards.
- **Wiring that exists is not a feature that works.** The plugin system had
  every piece in place and had never once loaded.
- **Count the copies before you merge them.** The handover said two language
  classifiers; the probe alone held four. A guard written against the *symptom*
  is what surfaced the extra two.
- **Stars and recent commits say nothing about whether a tool works.** One curl
  beat two READMEs.
- **A guard that can match prose is not guarding code.** Session 17's first
  carousel guard tripped on a word inside a comment, then passed wrongly because
  its regex anchored on a string that also appears in the stylesheet.

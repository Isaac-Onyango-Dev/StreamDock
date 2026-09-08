# Handover — next session

Written at the end of session 14 (2026-09-08), against `4b948a7`, on branch
`claude/test-linux-version-1b43c0`. Version **1.6.1** — deliberately not bumped,
nothing released.

`CLAUDE.md` is the long history and the working agreements — read it first.
This file is only what the *next* session should pick up, and why.

---

## 0. State of the branch

Three commits, none merged to main:

| Commit | What |
| --- | --- |
| `fcc2d65` | MIT `LICENSE` — the repo had claimed MIT since the beginning and carried no licence text |
| `7524730` | Episode patterns moved into `host-config.json`; `anikototv.to` resolves for the first time |
| `4b948a7` | One language model in `shared/language.ts`; an inferred language is now visibly a guess |

Pipeline is green: typecheck, ESLint 0/0, **192 tests**, `verify:engine`
**124 checks**, Playwright 10/10, production build.

**Two things still need Isaac at a keyboard** (no desktop automation for the
Electron window here): the inferred-language badge rendering in the real app,
and an `anikototv.to` episode range probed through the UI rather than through
`detectEpisodePattern()` directly.

Merging to main triggers nothing on its own — releasing is a `package.json`
version change on main, which also requires `npm run sync:docs` in the same
commit or `verify:engine` fails on the changelog check.

---

## 1. The reference-project question is answered — don't reopen it

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

## 2. First task: settle the anikoto embed question

This is the highest-value open item and it is a **single measurement**, not a
project.

StreamDock's bundled plugin already works as far as the embed. Confirmed by
running it:

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

Do not promise this as a one-liner before taking that measurement.

---

## 3. The cleaner anikoto route: it has a JSON API

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

Weigh it as a third-party dependency before building it; that is Isaac's call,
not an engineering default.

---

## 4. Still open, in rough value order

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
5. **`tsbuildinfo` files are committed.** `tsconfig.electron.tsbuildinfo` and
   `tsconfig.renderer.tsbuildinfo` are tracked build artifacts that churn on
   every build. They belong in `.gitignore`. Left alone this session because it
   was unrelated to the work.

**What still cannot be tested headlessly, and is exactly what hosts 4 depends
on:** the hidden `BrowserWindow` manifest extractor. It needs a real Electron
session. To move there you need Isaac to run the app against one of these URLs
and share `~/.config/streamdock/streamdock.log` (Linux) or
`%APPDATA%/streamdock/streamdock.log` (Windows). That log carries real spawn
command lines and verbatim stderr and has settled several bugs in one grep.

---

## 5. Environment notes

- **Isaac dual-boots Ubuntu 26.04** and may be on either OS. Sessions 13 and 14
  ran entirely from Linux.
- **No system node/npm on the Ubuntu box.** A user-local Node 20 lives at
  `~/.local/node-v20.18.1-linux-x64` — prepend it to `PATH`. The install
  timeouts `CLAUDE.md` records are a Windows/AV problem, not a project one.
- **No engine binaries in a fresh worktree** (`binaries/` is gitignored, and the
  main checkout holds Windows `.exe`s). `npm run download:binaries` fetches the
  Linux set; session 14 grabbed `yt-dlp_linux` alone (40MB) for a quick test.
- `gh` is installed and authenticated as `Isaac-Onyango-Dev`.
- Reference clones live in the session scratchpad, outside the repo, on purpose.

---

## 6. Pipeline

Run all of it before calling anything done:

```
npm run typecheck && npx eslint . && npm test && npm run verify:engine
npx playwright test && npm run build:app
```

Baseline: **192 tests, 124 engine checks, Playwright 10/10, ESLint 0/0.**

---

## 7. Habits this repo earned the hard way

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

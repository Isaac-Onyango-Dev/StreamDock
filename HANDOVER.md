# Handover — next session

Written at the end of session 15 (2026-09-08). Version **1.7.0**, released.

`CLAUDE.md` is the long history and the working agreements — read it first.
This file is only what the *next* session should pick up, and why.

---

## 0. Where things stand

v1.7.0 is published. Dubbed downloads work, including across an episode range,
and every content choice has a single home in the UI. Isaac confirmed dub on
episodes 1 and 2 of Bleach through the real app.

Baseline: **207 tests, 261 engine checks, Playwright 12/12, ESLint 0/0.**

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
5. ~~**The release-window collision**~~ — fixed in session 16, after confirming
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
  ran entirely from Linux.
- **No system node/npm on the Ubuntu box.** A user-local Node 20 lives at
  `~/.local/node-v20.18.1-linux-x64` — prepend it to `PATH`. The install
  timeouts `CLAUDE.md` records are a Windows/AV problem, not a project one.
- **No engine binaries in a fresh worktree** (`binaries/` is gitignored, and the
  main checkout holds Windows `.exe`s). `npm run download:binaries` fetches the
  Linux set; session 14 grabbed `yt-dlp_linux` alone (40MB) for a quick test.
- **The screenshot sources live at `Screenshots/` in the main checkout** (capital
  S), are untracked, and therefore **do not exist inside a worktree**. Point
  `npm run screenshots:build -- <path>` at them. Only the generated `.webp`
  files under `docs/assets/screenshots/` are committed.
- `gh` is installed and authenticated as `Isaac-Onyango-Dev`.
- Reference clones live in the session scratchpad, outside the repo, on purpose.

---

## 7. Pipeline

Run all of it before calling anything done:

```
npm run typecheck && npx eslint . && npm test && npm run verify:engine
npx playwright test && npm run build:app
```

Baseline: **207 tests, 261 engine checks, Playwright 12/12, ESLint 0/0.**

The site has its own manual step now: `npm run screenshots:build` re-encodes
`Screenshots/` into `docs/assets/screenshots/`. It is not part of any build and
CI never runs it — like `icons:build`, it needs a browser and it needs source
files that are not committed.

---

## 8. Habits this repo earned the hard way

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

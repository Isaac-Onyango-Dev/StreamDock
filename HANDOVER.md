# Handover — next session

Written at the end of session 13 (2026-09-08), against `290e4f6`, version
**1.6.1**, released and live.

`CLAUDE.md` is the long history and the working agreements — read it first, it is
worth the time. This file is only what the *next* session should pick up, and
why.

---

## 1. First task: evaluate two reference projects

Isaac asked specifically for this. Two anime CLI tools solve the problem
StreamDock keeps losing to — knowing which streaming hosts exist and how to get
a playable stream out of them:

- **https://github.com/sdaqo/anipy-cli** — Python, ~514 stars, active
  (pushed 2026-08-31). Describes itself as usable as an API as well as a CLI.
- **https://github.com/pystardust/ani-cli** — Shell, ~13.7k stars, very active
  (pushed 2026-09-05).

**The question to answer:** can either one increase the number of streaming
sites StreamDock supports, add download options it lacks, or fix a problem it
currently has? Specifically:

- Which providers do they support that StreamDock does not? StreamDock's list is
  `electron/host-config.json` and it is short.
- How do they discover a playable manifest? StreamDock uses a hidden Electron
  `BrowserWindow` (`manifest-extractor.ts`) plus bundled yt-dlp plugins. If these
  tools reach the same streams with plain HTTP calls, that is a far cheaper path
  and would work headlessly — which would also make this class of work testable
  in CI for the first time.
- How do they model sub vs dub, and multiple audio and subtitle tracks? That is
  StreamDock's weakest area (see section 3).
- Do they solve the anikoto / megacloud style extraction that StreamDock's
  bundled plugin currently fails at?

### The licence constraint — read before opening their source

**Both projects are GPL-3.0. StreamDock is MIT** (`package.json`; note there is
no `LICENSE` file in the repo at all, though the site footer claims MIT — worth
fixing separately).

Copying, adapting or closely paraphrasing GPL-3.0 source into this repo would
put StreamDock in violation. It is not a grey area and it must not happen by
accident while "porting a fix".

What is fine: reading them to learn **facts** — which hosts exist, what an
endpoint looks like, that a provider serves HLS behind a particular referer,
which sites are dead. Facts are not copyrightable. Implementations are.

So: study, take notes on providers and behaviour, then **write original code**
against the real site. If a genuinely good outcome would require using their
code, stop and tell Isaac, because that is a licensing decision, not an
engineering one.

---

## 2. What just shipped, and what it does not fix

**v1.6.1** (released, auto-update live for existing users):

- **Bundled plugins load at all, for the first time in any release.**
  `resolvePluginDirs()` handed yt-dlp each individual package folder;
  yt-dlp wants the folder that *holds* the packages and globs
  `<dir>/*/yt_dlp_plugins` itself. Given the wrong level it loaded nothing and
  said so only under `-v`. Proven by A/B against the real binary:
  `--plugin-dirs plugins/anikoto` → "Plugin directories: none", 1744 extractors,
  `Unsupported URL`; `--plugin-dirs plugins` → four packages, 1750 extractors,
  the Anikoto extractor runs.
- Choosing **None** for subtitles now means none. A global `embedSubs` setting
  ran *after* the per-download picker and defaulted to on.
  `shared/subtitle-args.ts` owns the whole decision now.
- The quality menu lists only resolutions the source reports, labelled
  "up to N" because `height<=N` is a ceiling.

**It does not make Isaac's sample URLs work.** Be clear about this — the release
was an honest improvement, not a fix for those hosts.

---

## 3. Where the real work is

The full audit is at
https://claude.ai/code/artifact/94a6e449-06b0-49c3-9708-6c3c19568834 —
**with one correction**: it marks bundled plugins as working. They were not, and
running the binary is what proved it. Treat the rest of it with that in mind.

Phases 1, 2 and 8 are done. Open, roughly in value order:

1. **Host coverage.** Three of four sample hosts are absent from
   `host-config.json` entirely, so they never reach the manifest extractor and
   fail as unsupported links. This is where the two reference projects should
   pay off.
2. **Episode detection is two hardcoded hosts.** `detectEpisodePattern()` in
   `playlist-inspector.ts` matches `shuttletv.su` and `anikoto.cz` by literal
   regex. Note `anikototv.to` is in `host-config.json` but *not* in that
   function — a different domain. Move patterns into config so hosts are data.
3. **Per-item quality detection for playlists.** `qualityOptions` is only
   populated when the probe resolved a single item, so a playlist reports none.
   Confirmed live: the YouTube playlist fixture returns `qualities: NONE`.
   Bound and cancel it — a 366-episode series must not block the UI.
4. **Five request fields are sent and never read** by the engine:
   `selectedAudioFormatId`, `selectedAudioManifestUrl`,
   `selectedSubtitleFormatIds`, `selectedSubtitleManifestUrls`, and the modal's
   displayed `resolvedFormat`. Either consume them or remove the per-track UI.
   Two subtitle tracks in one language are currently indistinguishable.
5. **mkv container choice.** `--merge-output-format mp4` is hardcoded. mp4 only
   carries `mov_text`, so embedding an ASS/SSA subtitle silently destroys
   styling, and multi-audio is fragile. This blocks doing 4 properly.
6. **Two language classifiers.** `manifest-parser.ts` reads real
   `#EXT-X-MEDIA:LANGUAGE`; `stream-options-probe.ts` substring-matches URLs for
   `dub`/`sub`/`raw`/`hub` and never returns blank, so a wrong guess looks
   confident. Merge before extending either.

---

## 4. URL fixtures — measured, not guessed

Isaac's samples, probed with the real yt-dlp 2026.08.19 plus bundled plugins:

| URL | Result |
| --- | --- |
| `youtube.com/watch?v=…&list=…` | playlist, 15 items, real title + thumbnail, **`qualities: NONE`** |
| `youtube.com/playlist?list=…` | identical to the above — both forms behave the same |
| `anikototv.to/watch/one-piece-odmau/ep-1` | plugin loads and reaches the site; fails on markup drift (`'NoneType' object has no attribute 'group'`, then "No video formats found") |
| `reanime.to/...?lang=dub` and `?lang=sub` | `Unsupported URL` — host absent from `host-config.json` |
| `animex.one/watch/...` (both) | `Unsupported URL` — host absent |
| `rivestream.app/watch?type=movie&id=…` | `Unsupported URL` — host absent |
| `shuttletv.su/watch/1368337` | `Unsupported URL` from yt-dlp; host *is* in `manifestProbeHosts`, but its episode pattern needs `?e=` and this URL has none |

The `reanime.to` pair is the best single test for sub/dub work: same episode,
two languages, correct answer known in advance.

**What was not tested, and is exactly what these hosts depend on:** the hidden
`BrowserWindow` manifest extractor. It needs a real Electron session and cannot
be exercised headlessly. To move on host coverage you need Isaac to run the app
against one of these URLs and share
`~/.config/streamdock/streamdock.log` (Linux) or
`%APPDATA%/streamdock/streamdock.log` (Windows). That log carries the real spawn
command lines and verbatim stderr and has settled several bugs in one grep.

---

## 5. Environment notes

- **Isaac is dual-booting Ubuntu 26.04** and may be on either OS. Session 13 ran
  entirely from Linux.
- **This Ubuntu box has no system node/npm.** A user-local Node 20 is installed
  at `~/.local/node-v20.18.1-linux-x64` — prepend it to `PATH`. `npm ci`
  completes in about a minute here; the install timeouts `CLAUDE.md` records are
  a Windows/AV problem, not a project one.
- `gh` is installed and authenticated as `Isaac-Onyango-Dev`.
- Git identity is set repo-locally; the remote is HTTPS via `gh auth setup-git`
  because SSH host-key verification fails non-interactively on this machine.
- Isaac does **not** currently have StreamDock installed on Ubuntu. The copy
  tested in session 12 was a temporary build that has been cleaned up.

## 6. Pipeline

Run all of it before calling anything done — this repo has been bitten
repeatedly by inspection-only changes:

```
npm run typecheck && npx eslint . && npm test && npm run verify:engine
npx playwright test && npm run build:app
```

Current baseline: **172 tests, 96 engine checks, Playwright 10/10, ESLint 0/0.**

Releasing is automatic: change the version in `package.json` on `main` and
`Build & Release` tags and publishes it. Do not push a tag by hand. A version
bump also requires regenerating the site in the same commit
(`npm run sync:docs`) or `verify:engine` fails on the changelog check.

## 7. Two habits this repo earned the hard way

- **A regression test that has never failed against its bug is not a test yet.**
  Revert the fix, watch it go red, restore. Every fix in session 13 was
  validated this way, including the structural `verify-engine` guards.
- **Wiring that exists is not a feature that works.** The plugin system had
  every piece in place — packages present, args passed, files packaged — and had
  never once loaded. One `-v` run against the real binary settled in seconds
  what reading the code had gotten wrong.

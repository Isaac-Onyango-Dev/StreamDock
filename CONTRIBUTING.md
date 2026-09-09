# Contributing to StreamDock

## Releasing

**Bump the version. That is the whole release process.**

```bash
npm run release:patch      # 1.5.0 -> 1.5.1   bug fixes
npm run release:minor      # 1.5.0 -> 1.6.0   new functionality
npm run release:major      # 1.5.0 -> 2.0.0   breaking changes
git push origin main
```

Everything after the push is automatic:

1. **Build & Release** (`.github/workflows/release.yml`) sees `package.json`'s
   version change on `main`, checks that no `v<version>` tag exists yet, and
   builds the Windows installer and the Linux AppImage.
2. It creates the `v<version>` tag and the GitHub Release, with the
   `CHANGELOG.md` section for that version as the body and GitHub's generated
   commit/PR list appended under it, and attaches every installer plus the
   `latest.yml` update manifest that `electron-updater` reads.
3. **Deploy Site** (`.github/workflows/deploy-site.yml`) reacts to that workflow
   finishing, regenerates `docs/index.html` and `README.md` from `package.json`
   and `CHANGELOG.md`, and pushes them back to `main`.

There is no manual tagging step, and there should never be one again.

### Platforms

| Platform | Built in CI | Published | Engines |
| --- | --- | --- | --- |
| Windows x64 | yes | yes — `StreamDock-Setup-Windows.exe` | `yt-dlp.exe` + BtbN win64 ffmpeg |
| Linux x64 | yes | yes — `StreamDock-Linux.AppImage` | `yt-dlp_linux` + BtbN linux64 ffmpeg |
| macOS | yes (compile check only) | **no** | none — see below |

`scripts/download-binaries.ts` is platform-aware: it picks the yt-dlp asset and
the BtbN ffmpeg archive matching `process.platform`/`process.arch`, extracts
them, and marks them executable off Windows. `linux-arm64` is in its table too,
for developing on ARM hardware; only x64 is released.

**macOS is not published**, and that is not a build problem — CI's macOS runner
packages a `.dmg` fine. Two things block it:

- BtbN publishes no macOS ffmpeg, so there is no automated source for the engine
  from the same place as the other platforms.
- An unsigned `.dmg` is refused by Gatekeeper as "damaged and can't be opened".
  Signing and notarizing needs an Apple Developer account (~$99/yr).

Publishing an unsigned, untested macOS build would be worse than publishing
nothing, so the release matrix omits it while CI keeps the packaging path from
rotting.

### The engine check

`npm run check:binaries` runs between fetching the engines and packaging them.
It asserts each of `yt-dlp`, `ffmpeg` and `ffprobe` exists, is a plausible size,
and **actually executes and prints the version it should**.

It exists because "the build succeeded" has meant nothing twice: v1.1.0 shipped
to users with an empty `resources/binaries/` (the download script only printed
instructions back then), and the same bug was latent for Linux until this check
was written — `download-binaries.ts` used to return early on non-Windows with a
clean exit, so CI packaged an engine-less AppImage and reported success. A
packaging step cannot tell "no engines needed" from "engines missing". This can.

### Before you bump

Add the `CHANGELOG.md` entry first — CI fails the build without it:

```markdown
## [1.6.0] - 2026-09-08

### Fixed
- What broke, and *why* it broke. The root cause is the valuable part.
```

Then check locally:

```bash
npm run check:version      # semver valid, documented, not moving backwards
npm run release:notes      # preview the release body verbatim
```

### Why not semantic-release or changesets

Both were considered and deliberately not adopted.

The drift this pipeline exists to fix was never about *choosing* the version
number. `package.json` was bumped correctly and on time, three times over. What
never happened was pushing the tag — a separate manual act that the release
workflow depended on and nobody performed. Automating the number would not have
fixed that; automating the tag does.

Against adopting them anyway:

- `semantic-release` regenerates `CHANGELOG.md` from commit subjects. This
  project's changelog carries root-cause explanations that a subject line cannot
  hold, and those entries are the release notes users and future maintainers
  actually read. Generating them from `fix: ...` lines would be a downgrade.
- Both add a large dependency tree to a repo that already has a slow, occasionally
  failing `npm install` on the maintainer's machine.
- Commit-message-driven versioning only works if commit discipline is enforced,
  which is one more thing to get wrong.

`npm version` gives a single command, an atomic commit, and no new dependencies.
If commit-message discipline is ever enforced repo-wide, `semantic-release` can
replace the bump step alone — the build, tag, release and site steps downstream
of it would not need to change.

## Source of truth

| Thing | Comes from |
| --- | --- |
| App version | `package.json` `version` — **the** source of truth |
| Site version badge, hero, footer | `package.json`, injected by `scripts/build-site.ts` |
| Site changelog section | `CHANGELOG.md`, parsed by `scripts/lib/changelog.ts` |
| README "What's New" | `CHANGELOG.md`, written by `scripts/sync-readme.ts` |
| Release notes | `CHANGELOG.md` + GitHub's generated commit list |
| Site download button | `releases/latest/download/StreamDock-Setup-Windows.exe` |

`docs/index.html` and the README's version section are **generated**. Edit
`docs/index.template.html` and `CHANGELOG.md` instead; CI overwrites the rest.

The download button resolves through GitHub's `releases/latest` redirect, so it
needs no version substitution — but that also means it serves whatever the
newest *published* release is. That is exactly why the site is no longer
regenerated on a version bump: it waits until the release exists, so it can
never advertise a version the button cannot deliver.

## Development

```bash
npm ci
npm run download:binaries   # yt-dlp + ffmpeg into binaries/
npm run download:plugins    # yt-dlp extractor plugins into plugins/
npm run dev
```

`npm ci` rather than `npm install`: it installs exactly what `package-lock.json`
pins and never rewrites it, which is what you want unless you are deliberately
changing a dependency.

### Node version

**Node 20.19.0 or newer** (`package.json` declares it in `engines`). The floor is
not arbitrary: `npm run build` runs electron-builder, which reaches ESM-only code
from CommonJS and therefore needs `require(esm)` — added in Node 20.19. On 20.18
packaging dies with `ERR_REQUIRE_ESM` **while typecheck, lint, tests and e2e all
pass**, so the version is worth checking before you conclude the build is broken.
CI runs 20.20.2.

### If you work on more than one operating system

`node_modules` is operating-system specific, and this repo is routinely checked
out on a drive shared between a Windows and a Linux boot. **Run `npm ci` after
every OS switch.** One install cannot serve both, and there is no configuration
that makes it.

Skipping it fails differently depending on which way you switched, which is why
it is worth recognising on sight:

- **Linux install, now on Windows.** npm writes `node_modules/.bin` as symlinks
  on Linux and as `.cmd` wrappers on Windows, so *nothing* resolves — every
  command reports `'tsc' is not recognized as an internal or external command`.
- **Windows install, now on Linux.** The wrong native binaries are present
  (`@esbuild/win32-x64` where `@esbuild/linux-x64` is needed), so `tsx`, `vite`
  and every build script fail — but `npm run typecheck` keeps passing, because
  `tsc` is pure JavaScript. A green typecheck is not evidence the toolchain works.

Line endings are already handled: `.gitattributes` pins `* text=auto eol=lf`, so
a Windows checkout will not rewrite the tree to CRLF and strand the other boot
with a working tree full of phantom modifications. Don't remove that file, and
don't "fix" `core.autocrlf` to compensate — the attribute is the enforcement.

## Before opening a PR

```bash
npm run typecheck       # both tsconfig projects
npm run lint            # zero-warning gate
npm test                # Vitest
npm run verify:engine   # static/unit checks, no binaries or network
npx playwright test     # e2e (browser only, no Electron needed)
npm run build:app       # production build without packaging
```

CI runs all of these plus the version guard.

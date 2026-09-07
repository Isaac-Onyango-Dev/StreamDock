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
   builds the Windows installer.
2. It creates the `v<version>` tag and the GitHub Release, with the
   `CHANGELOG.md` section for that version as the body and GitHub's generated
   commit/PR list appended under it, and attaches every installer plus the
   `latest.yml` update manifest that `electron-updater` reads.
3. **Deploy Site** (`.github/workflows/deploy-site.yml`) reacts to that workflow
   finishing, regenerates `docs/index.html` and `README.md` from `package.json`
   and `CHANGELOG.md`, and pushes them back to `main`.

There is no manual tagging step, and there should never be one again.

### Why only Windows is published

`scripts/download-binaries.ts` fetches `yt-dlp.exe` and a win64 ffmpeg build
unconditionally. Running the release on a macOS or Linux runner would package
those Windows executables inside a `.dmg`/`.AppImage` — it would install and
then fail every download, since the bundled engine cannot run. That is worse
than shipping nothing for those platforms.

CI still builds macOS and Linux on every push to `main`, so their packaging path
stays exercised. Teaching `download-binaries.ts` to fetch per-platform engines is
the single change needed before adding them to the release matrix.

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
npm install
npm run download:binaries   # yt-dlp + ffmpeg into binaries/
npm run download:plugins    # yt-dlp extractor plugins into plugins/
npm run dev
```

## Before opening a PR

```bash
npm run typecheck       # both tsconfig projects
npx eslint .            # zero-warning gate
npm test                # Vitest
npm run verify:engine   # static/unit checks, no binaries or network
npx playwright test     # e2e (browser only, no Electron needed)
npm run build:app       # production build without packaging
```

CI runs all of these plus the version guard.

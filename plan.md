# StreamDock — Implementation Plan
> Desktop-only successor to Internet Download Manager. Uses AB Download Manager's dark desktop design language without copying its assets.

---

## Product Scope

Two primary flows:

### Video Download
Paste a media URL → analyze → download to file.
**Supported platforms:** YouTube, YouTube Music, Instagram, TikTok

### Live Stream Capture
Paste a live or manifest URL → capture to disk.
**Supported platforms:** Anikoto / AnikotoTV, AnimePahe, FMovies, SuperNova, hianime.to / hianime.re, gojoora, everythingmoe.com

---

## Smart Naming

All downloads are organized with structured naming conventions.

### Playlists
```
[Playlist Name]/
  [01]-[Song Name]-[Artist]
  [02]-[Song Name]-[Artist]
  ...
```
- The folder name must accurately describe the playlist — **not** derived from the first track title.

### Episodes / Anime / Movies
```
[Series Name]/
  Season 1/
    Episode 01
    Episode 02
  Season 2/
    ...
```
- If no season info exists, episodes go directly inside the series folder.

---

## Architecture

| Layer | Responsibility |
|---|---|
| `electron/main.ts` | App lifecycle, IPC handlers |
| `electron/preload.ts` | Secure `window.streamDock` bridge |
| `electron/download-engine.ts` | yt-dlp spawning, progress parsing, error events — **only file that spawns yt-dlp** |
| `electron/binary-resolver.ts` | Checks `binaries/` → userData `binaries/` → `PATH` |
| `electron/url-router.ts` | Authoritative URL validation and mode suggestion (main process only) |
| `electron/manifest-extractor.ts` | Hidden BrowserWindow to discover `.ts` / `.m3u8` / `.mpd` manifests from JS-player sites |
| `electron/error-translator.ts` | User-facing error copy |
| `electron/ipc-channels.ts` | **Single source of truth** for all IPC channel constants |
| `electron/smart-naming.ts` | Pure-function output template builder — produces yt-dlp `-o` template strings for playlists, episodes, streams, and single videos || `client/src/App.tsx` | App state and event wiring |
| `client/src/components/*` | Shell, URL capture, settings, queue, progress, error UI |

**Key constraint:** The renderer must never override a manually selected capture mode after analysis. URL inference is only a first hint on paste/auto-read.

---

## IPC Channels

All channels must be declared in `electron/ipc-channels.ts`.

| Channel | Direction | Purpose |
|---|---|---|
| `app:get-version` | Renderer → Main | Fetch app version |
| `app:engine-version-warning` | Main → Renderer | Warn when yt-dlp is outdated |
| `dialog:select-download-folder` | Renderer → Main | Open folder picker |
| `clipboard:read-text` | Renderer → Main | Read clipboard |
| `url:analyze` | Renderer → Main | Validate URL, suggest mode |
| `url:inspect` | Renderer → Main | Probe playlist/episode metadata for naming and previews |
| `media:probe-tracks` | Renderer → Main | Discover audio dub and subtitle tracks from manifests / yt-dlp |
| `download:start-video` | Renderer → Main | Begin video download |
| `download:start-stream` | Renderer → Main | Begin stream capture |
| `download:pause` | Renderer → Main | Pause a running or queued download |
| `download:resume` | Renderer → Main | Resume a paused download |
| `download:retry` | Renderer → Main | Retry a failed download |
| `download:cancel` | Renderer → Main | Cancel active download |
| `download:stop-all` | Renderer → Main | Pause or cancel all active and queued downloads |
| `download:resume-all` | Renderer → Main | Resume all paused downloads |
| `download:reorder` | Renderer → Main | Reorder a queued download |
| `download:list` | Renderer → Main | Hydrate persisted transfer dock records |
| `download:open-file` | Renderer → Main | Open completed file |
| `download:show-in-folder` | Renderer → Main | Reveal file in explorer |
| `settings:get` | Renderer → Main | Fetch settings |
| `settings:update` | Renderer → Main | Persist settings |
| `event:download-progress` | Main → Renderer | Progress update |
| `event:download-complete` | Main → Renderer | Download finished |
| `event:download-error` | Main → Renderer | Error surfaced to UI |
| `event:engine-status` | Main → Renderer | yt-dlp engine readiness |
| `event:stall` | Main → Renderer | Download stall notification |
| `event:network-status` | Main → Renderer | Network status notification |
| `event:queue-changed` | Main → Renderer | Queue order or count notification |
| `engine:clear-records` | Renderer → Main | Clear terminal transfer records; accepts `all`, `completed`, `failed`, or `cancelled` |
| `engine:update` | Renderer → Main | Run yt-dlp self-update |
| `engine:status` | Renderer → Main | Fetch yt-dlp and ffmpeg availability |

---

## Assets

| File | Purpose |
|---|---|
| `assets/logo.svg` | StreamDock wordmark |
| `assets/icon.svg` | Source icon |
| `assets/icon.png` | macOS / Linux icon |
| `assets/icon.ico` | Windows icon |

---

## Contributor Rules

1. **Desktop-only.** No web deployment, Render/Replit, `docs/web`, or browser-mode fallbacks.
2. **Surface all errors to UI** via `event:download-error`. Do not silently swallow user-action failures.
3. **Tailwind stays on v3.x** unless the entire project is deliberately migrated together.
4. **New IPC channels** must be added through `electron/ipc-channels.ts` and documented in this plan.
5. **AB Download Manager / Internet Download Manager** are read-only visual references — do not copy their assets.
6. **Quality selection** is explicit in the URL capture panel and passed to `download-engine.ts` as a yt-dlp format expression.
7. **Manifest extraction** for JS-player sites (Anikoto, etc.) is handled exclusively in `manifest-extractor.ts` via hidden BrowserWindow.

---

## Validation Targets

Before marking any task complete, confirm all three pass:

```bash
npm.cmd run typecheck
npm.cmd run verify:engine
npm.cmd run build:app
```

Then run a manual Electron smoke test covering:
- [ ] Video mode — successful download
- [ ] Stream mode — successful capture
- [ ] Invalid URL — error surfaces in UI
- [ ] Missing engine — `event:engine-status` handled gracefully
- [ ] Cancel — in-progress download cancels cleanly
- [ ] Open file — opens completed download
- [ ] Show in folder — reveals file in system explorer

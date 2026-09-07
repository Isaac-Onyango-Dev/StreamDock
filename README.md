# StreamDock

[![Downloads](https://img.shields.io/github/downloads/Isaac-Onyango-Dev/StreamDock/total?label=Downloads&style=for-the-badge&color=8B5CF6)](https://github.com/Isaac-Onyango-Dev/StreamDock/releases)

Desktop-only Electron app for downloading videos and capturing live streams with `yt-dlp` and `ffmpeg`.

## ✨ What's New in v1.0.1

**Dynamic Wallpaper System**
Bring your workspace to life with the new background engine. Choose from Bing's
daily wallpaper — updated automatically on your schedule — or set a custom color
using the full palette picker. Your preference is saved and restored every time
you launch the app.

- 🖼️  Bing daily wallpaper with live auto-refresh
- ⏱️  Configurable refresh interval (1h → 48h) with live countdown
- 🎨  Custom background color — presets + full color wheel
- 💾  All settings persist across restarts

## Scripts

- `npm run dev` — start Vite and Electron.
- `npm run typecheck` — TypeScript check.
- `npm run verify:engine` — smart-naming and IPC wiring checks.
- `npm run build:app` — build renderer, main process, and preload.
- `npm run build` — package the desktop app.

## Binaries

Run `npm run download:binaries` to fetch real `yt-dlp`, `ffmpeg`, and `ffprobe`
binaries into `binaries/` (Windows only — macOS/Linux aren't distributed yet).
It's idempotent, so re-running it just skips files that are already there.
This step also runs in CI before every packaged build. Alternatively, install
the binaries on `PATH` yourself — StreamDock surfaces missing-binary errors
in the UI either way.

# StreamDock

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

Place `yt-dlp` and `ffmpeg` binaries in `binaries/`, or install them on `PATH`. StreamDock surfaces missing-binary errors in the UI.

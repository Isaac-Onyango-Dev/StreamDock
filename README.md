# StreamDock

Desktop-only Electron app for downloading videos and capturing live streams with `yt-dlp` and `ffmpeg`.

## Scripts

- `npm run dev` — start Vite and Electron.
- `npm run typecheck` — TypeScript check.
- `npm run verify:engine` — smart-naming and IPC wiring checks.
- `npm run build:app` — build renderer, main process, and preload.
- `npm run build` — package the desktop app.

## Binaries

Place `yt-dlp` and `ffmpeg` binaries in `binaries/`, or install them on `PATH`. StreamDock surfaces missing-binary errors in the UI.

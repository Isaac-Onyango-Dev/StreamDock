// Role: Vite configuration for the StreamDock renderer and Electron build.
import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'client',
  base: './',
  // No public directory. This used to point at `assets/`, which is the folder
  // electron-builder takes its *installer* icons from — so every build copied
  // icon.ico, icon.png and the eight Linux icon sizes (~965 KB) into
  // dist/client/, and from there into the asar. The renderer requests none of
  // them: it draws its mark as inline SVG (components/BrandMark.tsx). The app's
  // real icons reach it through electron-builder's `extraResources`, and
  // main.ts resolves them from `process.resourcesPath` / `app.getAppPath()`,
  // never from dist/client — so that path is unaffected.
  publicDir: false,
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(process.cwd(), 'client/src'),
    },
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
});

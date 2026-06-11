// Role: Vite configuration for the StreamDock renderer and Electron build.
import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'client',
  base: './',
  publicDir: path.resolve(process.cwd(), 'assets'),
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

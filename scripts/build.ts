// Role: production build script for renderer, main process, and preload.
import { build } from 'esbuild';
import { rm } from 'fs/promises';
import { execFileSync } from 'child_process';

await rm('dist-electron', { recursive: true, force: true });
if (process.platform === 'win32') {
  execFileSync('cmd.exe', ['/c', 'npx vite build'], { stdio: 'inherit' });
} else {
  execFileSync('npx', ['vite', 'build'], { stdio: 'inherit' });
}

const common = {
  bundle: true,
  platform: 'node' as const,
  // electron-updater must stay external, like electron-log: it resolves parts of
  // itself and its deps dynamically at runtime, which esbuild cannot follow into
  // a single file. electron-builder copies production dependencies into the asar,
  // so it is there to require at runtime.
  external: ['electron', 'electron-log', 'electron-updater'],
  sourcemap: false,
};

await build({
  ...common,
  entryPoints: ['electron/main.ts'],
  outfile: 'dist-electron/main.cjs',
  format: 'cjs',
});

await build({
  ...common,
  entryPoints: ['electron/preload.ts'],
  outfile: 'dist-electron/preload.cjs',
  format: 'cjs',
});

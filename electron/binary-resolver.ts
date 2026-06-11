// Role: cross-platform binary path resolution and availability checks.
import { execSync } from 'child_process';
import { app } from 'electron';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { delimiter, dirname, join } from 'path';

export interface BinaryStatus {
  name: 'yt-dlp' | 'ffmpeg';
  path: string | null;
  available: boolean;
}

export interface YtDlpCommand {
  command: string;
  args: string[];
  type: 'native' | 'python';
}

export function resolvePluginDirs(userDirs: string[] = []): string[] {
  const { readdirSync, statSync } = require('fs') as typeof import('fs');

  const roots: string[] = [...userDirs];
  const dataPlugins = join(app.getPath('userData'), 'plugins');
  if (existsSync(dataPlugins)) roots.push(dataPlugins);

  const appPlugins = process.env.NODE_ENV === 'development' || !app.isPackaged
    ? join(app.getAppPath(), 'plugins')
    : join(process.resourcesPath, 'plugins');
  if (existsSync(appPlugins)) roots.push(appPlugins);

  // yt-dlp's --plugin-dirs expects each entry to directly CONTAIN a
  // yt_dlp_plugins/ subfolder. Our layout is:
  //   plugins/<name>/yt_dlp_plugins/...
  // So we expand each root into its immediate subdirectories.
  const dirs: string[] = [];
  for (const root of roots) {
    try {
      // Check if the root itself is a flat plugin dir (legacy layout)
      if (existsSync(join(root, 'yt_dlp_plugins'))) {
        dirs.push(root);
        continue;
      }
      // Otherwise enumerate subdirs — each one that has yt_dlp_plugins/ is a plugin
      for (const entry of readdirSync(root)) {
        const sub = join(root, entry);
        try {
          if (statSync(sub).isDirectory() && existsSync(join(sub, 'yt_dlp_plugins'))) {
            dirs.push(sub);
          }
        } catch { /* skip unreadable entries */ }
      }
    } catch { /* skip unreadable roots */ }
  }

  return dirs.filter((dir, index, list) => list.indexOf(dir) === index);
}

export function buildPluginDirArgs(userDirs: string[] = []): string[] {
  return resolvePluginDirs(userDirs).flatMap((dir) => ['--plugin-dirs', dir]);
}

function executableNames(base: 'yt-dlp' | 'ffmpeg'): string[] {
  if (process.platform === 'win32') return [`${base}.exe`, base];
  return [base];
}

function candidates(base: 'yt-dlp' | 'ffmpeg'): string[] {
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  const roots = [
    join(app.getPath('userData'), 'binaries'),
    isDev ? join(app.getAppPath(), 'binaries') : join(process.resourcesPath, 'binaries'),
  ];

  return roots.flatMap((root) => executableNames(base).map((name) => join(root, name)));
}

function bundledBinaryPath(base: 'yt-dlp' | 'ffmpeg'): string | null {
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  const root = isDev ? join(app.getAppPath(), 'binaries') : join(process.resourcesPath, 'binaries');
  return executableNames(base).map((name) => join(root, name)).find(existsSync) ?? null;
}

function userBinaryPath(base: 'yt-dlp' | 'ffmpeg'): string {
  return join(app.getPath('userData'), 'binaries', executableNames(base)[0]);
}

function findOnPath(base: 'yt-dlp' | 'ffmpeg'): string | null {
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(delimiter)) {
    for (const name of executableNames(base)) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function resolveBinary(base: 'yt-dlp' | 'ffmpeg'): string {
  for (const candidate of candidates(base)) {
    if (existsSync(candidate)) return candidate;
  }

  const pathCandidate = findOnPath(base);
  if (pathCandidate) return pathCandidate;

  throw new Error(`${base} not found`);
}

function findPythonYtDlp(): { command: string; args: string[] } | null {
  const pythons = process.platform === 'win32'
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];

  for (const py of pythons) {
    try {
      execSync(`"${py}" -m yt_dlp --version`, {
        timeout: 5000,
        windowsHide: true,
        stdio: 'pipe',
        encoding: 'utf-8',
      });
      return { command: py, args: ['-m', 'yt_dlp'] };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Resolve a yt-dlp command suitable for spawning.
 *
 * When `preferPython` is `true`, the Python-module variant
 * (e.g. `python -m yt_dlp`) is tried first — this is useful for
 * sites that are only supported by custom yt-dlp forks such as
 * yt-dlp-hianime.
 */
export function resolveYtDlpCommand(preferPython = false): YtDlpCommand {
  if (preferPython) {
    const pyCmd = findPythonYtDlp();
    if (pyCmd) return { ...pyCmd, type: 'python' };
  }

  try {
    const path = resolveBinary('yt-dlp');
    return { command: path, args: [], type: 'native' };
  } catch {
    // Native binary not available; try Python fallback
  }

  if (!preferPython) {
    const pyCmd = findPythonYtDlp();
    if (pyCmd) return { ...pyCmd, type: 'python' };
  }

  throw new Error('yt-dlp not found');
}

export function resolveUpdatableYtDlpCommand(): YtDlpCommand {
  const userPath = userBinaryPath('yt-dlp');
  if (existsSync(userPath)) return { command: userPath, args: [], type: 'native' };

  const bundledPath = bundledBinaryPath('yt-dlp');
  if (bundledPath) {
    mkdirSync(dirname(userPath), { recursive: true });
    copyFileSync(bundledPath, userPath);
    if (process.platform !== 'win32') chmodSync(userPath, 0o755);
    return { command: userPath, args: [], type: 'native' };
  }

  const pyCmd = findPythonYtDlp();
  if (pyCmd) return { ...pyCmd, type: 'python' };

  throw new Error('yt-dlp not found');
}

export function getBinaryStatus(): BinaryStatus[] {
  return (['yt-dlp', 'ffmpeg'] as const).map((name) => {
    try {
      const path = resolveBinary(name);
      return { name, path, available: true };
    } catch {
      return { name, path: null, available: false };
    }
  });
}

// Role: refresh the vendored yt-dlp plugin packages from their upstream repos.
//
// The plugins are committed to this repository and packaged via
// `extraResources`, so this script is NOT needed for a build — it exists to pull
// upstream changes when an extractor goes stale. It rewrites vendored, reviewed
// code, so review the diff afterwards rather than committing it blind.
//
// Two roots, not one. yt-dlp is handed `plugins/` and `plugins-win/` as roots
// and globs `<root>/*/yt_dlp_plugins` itself. ChromeCookieUnlock lives in the
// Windows-only root because it imports `windll` at module level: loaded off
// Windows it prints an ImportError traceback into the stderr that StreamDock
// shows users on a failed download. Anything written into `plugins/` loads on
// every platform, so a Windows-only package must not go there.
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, cpSync } from 'fs';
import { join } from 'path';

/**
 * Extract a GitHub source zip.
 *
 * GNU tar cannot read a zip at all ("This does not look like a tar archive"),
 * and this script downloads a zip on every platform — so the previous bare
 * `tar -xf` meant the whole script had never once worked on Linux or macOS.
 * Every package failed, silently, because the failure was swallowed by the
 * catch below and reported as "FAILED to install ... from any branch".
 *
 * Windows' own tar IS bsdtar and does read zips, so use it explicitly there —
 * a bare `tar` can resolve to Git for Windows' GNU tar when its bin directory
 * precedes System32 on PATH. Elsewhere, use unzip.
 */
function extractZip(zipPath: string, destDir: string): void {
  if (process.platform === 'win32') {
    const systemTar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const tarCommand = existsSync(systemTar) ? systemTar : 'tar';
    execFileSync(tarCommand, ['-xf', zipPath, '-C', destDir], { stdio: 'pipe' });
    return;
  }
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', destDir], { stdio: 'pipe' });
}

// Must stay in step with resolvePluginDirs() in electron/binary-resolver.ts.
const PLUGIN_ROOTS = {
  all: join(process.cwd(), 'plugins'),
  win: join(process.cwd(), 'plugins-win'),
} as const;

// `repo: null` means the upstream is gone and our vendored copy is the only one
// left — such a package is reported and skipped, never deleted.
const PLUGINS: ReadonlyArray<{
  name: string;
  repo: string | null;
  root: keyof typeof PLUGIN_ROOTS;
}> = [
  { name: 'ChromeCookieUnlock', repo: 'seproDev/yt-dlp-ChromeCookieUnlock', root: 'win' },
  { name: 'POTProvider', repo: 'Brainicism/bgutil-ytdlp-pot-provider', root: 'all' },
  { name: 'anikoto', repo: 'yt-dlp-plugins/yt-dlp-anikoto', root: 'all' },
  { name: 'animepahe', repo: 'yt-dlp-plugins/yt-dlp-animepahe', root: 'all' },
  // Tons-7/yt-dlp-aniwatchtv-kaido returned 404 for the repo page, the API and
  // both branch archives when checked on 2026-09-08 — deleted or made private.
  // `plugins/aniwatchtv-kaido/` is therefore the only surviving copy of these
  // three extractors (aniwatch, kaido, megacloud). Do not remove it, and do not
  // treat the skip below as a bug in this script.
  { name: 'aniwatchtv-kaido', repo: null, root: 'all' },
];

for (const dir of Object.values(PLUGIN_ROOTS)) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

for (const plugin of PLUGINS) {
  const PLUGINS_DIR = PLUGIN_ROOTS[plugin.root];
  const pluginDest = join(PLUGINS_DIR, plugin.name);

  if (plugin.repo === null) {
    console.log(
      `[Plugin] ${plugin.name}: upstream is gone — keeping the vendored copy as-is.`,
    );
    continue;
  }

  if (existsSync(pluginDest)) {
    console.log(`[Plugin] ${plugin.name} already installed. Removing...`);
    rmSync(pluginDest, { recursive: true, force: true });
  }

  let success = false;
  for (const branch of ['master', 'main']) {
    const zipUrl = `https://github.com/${plugin.repo}/archive/refs/heads/${branch}.zip`;
    const zipPath = join(PLUGINS_DIR, `${plugin.name}.zip`);
    
    console.log(`[Plugin] Trying to download ${plugin.name} from branch ${branch}...`);
    try {
      // -f so a 404 (branch does not exist) fails rather than saving an error page.
      execFileSync('curl', ['-f', '-L', '-o', zipPath, zipUrl], { stdio: 'pipe' });

      console.log(`[Plugin] Extracting ${plugin.name}...`);
      extractZip(zipPath, PLUGINS_DIR);

      // Find the extracted folder (it's the only one that matches repoName-* that is a directory)
      const repoName = plugin.repo.split('/')[1];
      const items = readdirSync(PLUGINS_DIR, { withFileTypes: true });
      const extractedDir = items.find(i => i.isDirectory() && i.name.startsWith(repoName));
      
      if (extractedDir) {
        const extractedFolderPath = join(PLUGINS_DIR, extractedDir.name);
        
        // Recursively find yt_dlp_plugins
        const findYtDlpPlugins = (dir: string): string | null => {
          const contents = readdirSync(dir, { withFileTypes: true });
          for (const c of contents) {
            if (c.isDirectory() && c.name === 'yt_dlp_plugins') return join(dir, c.name);
            if (c.isDirectory()) {
              const res = findYtDlpPlugins(join(dir, c.name));
              if (res) return res;
            }
          }
          return null;
        };
        
        const sourceYtDlpPlugins = findYtDlpPlugins(extractedFolderPath);
        
        if (sourceYtDlpPlugins) {
          mkdirSync(pluginDest, { recursive: true });
          cpSync(sourceYtDlpPlugins, join(pluginDest, 'yt_dlp_plugins'), { recursive: true });
          console.log(`[Plugin] Successfully installed ${plugin.name}.`);
          success = true;
        } else {
          console.warn(`[Plugin] WARNING: Could not find yt_dlp_plugins inside ${extractedFolderPath}`);
        }
        
        rmSync(extractedFolderPath, { recursive: true, force: true });
      } else {
        console.error(`[Plugin] Extraction folder not found for ${plugin.name}`);
      }
      
      if (existsSync(zipPath)) rmSync(zipPath);
      if (success) break; // Don't try other branches if successful
    } catch {
      if (existsSync(zipPath)) rmSync(zipPath);
      // Silently try the next branch
    }
  }
  
  if (!success) {
    console.error(`[Plugin] FAILED to install ${plugin.name} from any branch.`);
  }
}

console.log('Plugin download complete.');

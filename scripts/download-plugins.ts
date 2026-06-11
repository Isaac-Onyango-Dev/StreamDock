import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, renameSync, readdirSync, cpSync } from 'fs';
import { join } from 'path';

const PLUGINS_DIR = join(process.cwd(), 'plugins');

const PLUGINS = [
  { name: 'ChromeCookieUnlock', repo: 'seproDev/yt-dlp-ChromeCookieUnlock', branch: 'master' },
  { name: 'POTProvider', repo: 'Brainicism/bgutil-ytdlp-pot-provider', branch: 'main' },
  { name: 'anikoto', repo: 'yt-dlp-plugins/yt-dlp-anikoto', branch: 'master' },
  { name: 'aniwatchtv-kaido', repo: 'Tons-7/yt-dlp-aniwatchtv-kaido', branch: 'main' },
  { name: 'anime-media-fetcher', repo: 'Piscado140303/anime-media-fetcher', branch: 'main' },
  { name: 'animepahe', repo: 'yt-dlp-plugins/yt-dlp-animepahe', branch: 'master' }
];

if (!existsSync(PLUGINS_DIR)) {
  mkdirSync(PLUGINS_DIR, { recursive: true });
}

for (const plugin of PLUGINS) {
  const pluginDest = join(PLUGINS_DIR, plugin.name);
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
      // Use -f to fail on 404
      execSync(`curl -f -L -o "${zipPath}" "${zipUrl}"`, { stdio: 'pipe' });
      
      console.log(`[Plugin] Extracting ${plugin.name}...`);
      execSync(`tar -xf "${zipPath}" -C "${PLUGINS_DIR}"`, { stdio: 'pipe' });
      
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
    } catch (err) {
      if (existsSync(zipPath)) rmSync(zipPath);
      // Silently try the next branch
    }
  }
  
  if (!success) {
    console.error(`[Plugin] FAILED to install ${plugin.name} from any branch.`);
  }
}

console.log('Plugin download complete.');

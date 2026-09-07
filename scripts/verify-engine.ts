// This script runs under plain Node (tsx), NOT under Electron, so it must not
// pull in anything that reaches the `electron` module at import time. It used to
// import `../electron/url-router`, whose top-level `import { app } from
// 'electron'` resolves to the npm shim outside Electron — a module with no named
// exports. That threw
//   SyntaxError: The requested module 'electron' does not provide an export named 'app'
// before a single assertion ran, which is why this script had never once
// executed successfully, on CI or anywhere else.
//
// The host checks below read electron/host-config.json directly instead. That is
// also the better check for a verification script: it asserts against the
// configuration actually shipped, rather than against the hardcoded fallback the
// router uses when that file is missing.
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildOutputTemplate, sanitizeName } from '../electron/smart-naming';

const root = join(import.meta.dirname, '..');
let assertions = 0;

function assert(condition: boolean, message: string): void {
  assertions += 1;
  if (!condition) {
    throw new Error(message);
  }
}

function readProjectFile(path: string): string {
  return readFileSync(join(root, path), 'utf-8');
}

function verifySmartNaming(): void {
  assert(sanitizeName('My: Show/Name?') === 'My_ Show_Name_', 'sanitizeName replaces invalid filename characters');
  assert(sanitizeName('   ') === 'Download', 'sanitizeName falls back when the value is empty');

  assert(
    buildOutputTemplate({ mode: 'stream' }) === 'StreamDock Stream %(upload_date>%Y-%m-%d)s %(epoch>%H-%M-%S)s.%(ext)s',
    'stream captures use a timestamped output template',
  );
  // These encoded the pre-rewrite templates ('%(playlist_index)03d-%(title)' and
  // a zero-padded 'Season %02d'). The naming spec was deliberately changed to
  // literal 'Episode (N)' with an unpadded 'Season N', and smart-naming.test.ts
  // was updated at the time — this script was not, because it could not run.
  assert(
    buildOutputTemplate({ mode: 'video', isPlaylist: true, folderHint: 'Road Trip' }) ===
      'Road Trip/%(season_number&Season %d/|)sEpisode (%(playlist_index)d).%(ext)s',
    'playlists use a folder and literal "Episode (N)" naming',
  );
  assert(
    buildOutputTemplate({ mode: 'video', playlistItems: '1-5' }) ===
      '%(playlist_title).150B/%(season_number&Season %d/|)sEpisode (%(playlist_index)d).%(ext)s',
    'playlist ranges fall back to playlist title metadata for the folder',
  );
  assert(
    buildOutputTemplate({ mode: 'video', folderHint: 'Demon Slayer' }) ===
      'Demon Slayer/%(season_number&Season %d/|)sEpisode (%(playlist_index)d).%(ext)s',
    'series downloads include an optional, unpadded season folder',
  );
  assert(
    buildOutputTemplate({ mode: 'video' }) === '%(title).150B.%(ext)s',
    'single videos stay flat in the output directory',
  );
}

function verifyEngineWiring(): void {
  const appSource = readProjectFile('client/src/App.tsx');
  const storeSource = readProjectFile('client/src/store/DownloadStore.ts');
  const mainSource = readProjectFile('electron/main.ts');
  const preloadSource = readProjectFile('electron/preload.ts');
  const engineSource = readProjectFile('electron/download-engine.ts');

  assert(appSource.includes('downloadStore.init()'), 'renderer initializes the download store on startup');
  assert(storeSource.includes('window.streamDock.listDownloads()'), 'download store hydrates persisted transfer records');
  assert(storeSource.includes('clearEngineRecords(scope)'), 'download store calls scoped engine cleanup');
  assert(appSource.includes("clearRecords('completed')"), 'Clear Done routes through the download store');
  assert(appSource.includes("clearRecords('failed')"), 'Clear Failed routes through the download store');
  assert(mainSource.includes("scope?: 'all' | 'completed' | 'failed' | 'cancelled'"), 'main process accepts scoped clear requests');
  assert(preloadSource.includes('type ClearRecordScope'), 'preload exposes the scoped clear type');
  assert(engineSource.includes("type ClearRecordScope = 'all' | 'completed' | 'failed' | 'cancelled'"), 'engine defines scoped clear behavior');
  assert(engineSource.includes('buildOutputTemplate('), 'download engine uses the smart-naming module');
  assert(engineSource.includes('resolveOutputPath('), 'download engine resolves output templates before passing -o');
  assert(engineSource.includes('isAbsolute(template)'), 'download engine preserves absolute output templates');
  assert(engineSource.includes("'--retry-sleep', 'fragment:exp=1:10'"), 'download engine uses valid yt-dlp retry sleep syntax');
  assert(!engineSource.includes('fragment:exp=1:max=10'), 'download engine does not use invalid retry sleep max syntax');
  assert(mainSource.includes('resolveUpdatableYtDlpCommand()'), 'engine update uses a user-writable yt-dlp target');
}

interface HostConfig {
  referenceHosts: string[];
  manifestProbeHosts: string[];
  animeHosts: string[];
}

function readHostConfig(): HostConfig {
  return JSON.parse(readProjectFile('electron/host-config.json')) as HostConfig;
}

function verifyRouteCoverage(): void {
  const config = readHostConfig();

  for (const host of ['fmovies.to', 'fmovies.ps', 'hianime.re', 'aniwatch.to', 'aniwatch.com']) {
    assert(config.manifestProbeHosts.includes(host), `${host} is available for manifest probing`);
  }
  for (const host of ['hianime.re', 'gojoora.com', 'gojoora.net']) {
    assert(config.animeHosts.includes(host), `${host} is available as an anime extractor host`);
  }

  // everythingmoe is a reference index, not a source. It was previously listed
  // in BOTH referenceHosts and the functional lists, so extraction was still
  // attempted against it; this script asserted that broken state as if it were
  // correct. Guard the config against reintroducing it — url-router.test.ts
  // covers the same invariant at the code level.
  for (const host of ['everythingmoe.com', 'everythingmoe.org']) {
    assert(config.referenceHosts.includes(host), `${host} is registered as a reference-only index`);
    assert(!config.manifestProbeHosts.includes(host), `${host} is NOT treated as a manifest-probe source`);
    assert(!config.animeHosts.includes(host), `${host} is NOT treated as an anime extractor host`);
  }
}

verifySmartNaming();
verifyEngineWiring();
verifyRouteCoverage();

console.log(`StreamDock engine verification passed (${assertions} checks).`);

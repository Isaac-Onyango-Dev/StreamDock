import { readFileSync } from 'fs';
import { join } from 'path';
import { buildOutputTemplate, sanitizeName } from '../electron/smart-naming';
import { ANIME_HOSTS, MANIFEST_PROBE_HOSTS } from '../electron/url-router';

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
  assert(
    buildOutputTemplate({ mode: 'video', isPlaylist: true, folderHint: 'Road Trip' }) ===
      'Road Trip/%(playlist_index)03d-%(title).150B.%(ext)s',
    'playlists use a folder and zero-padded index',
  );
  assert(
    buildOutputTemplate({ mode: 'video', playlistItems: '1-5' }) ===
      '%(playlist_title).150B/%(playlist_index)03d-%(title).150B.%(ext)s',
    'playlist ranges fall back to playlist title metadata',
  );
  assert(
    buildOutputTemplate({ mode: 'video', folderHint: 'Demon Slayer' }) ===
      'Demon Slayer/%(season_number&Season %02d/|)s%(title).150B.%(ext)s',
    'series downloads include the optional season folder',
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

function verifyRouteCoverage(): void {
  for (const host of ['fmovies.to', 'fmovies.ps', 'everythingmoe.com', 'hianime.re', 'aniwatch.to', 'aniwatch.com']) {
    assert(MANIFEST_PROBE_HOSTS.includes(host), `${host} is available for manifest probing`);
  }
  for (const host of ['everythingmoe.com', 'hianime.re', 'gojoora.com', 'gojoora.net']) {
    assert(ANIME_HOSTS.includes(host), `${host} is available as an anime extractor host`);
  }
}

verifySmartNaming();
verifyEngineWiring();
verifyRouteCoverage();

console.log(`StreamDock engine verification passed (${assertions} checks).`);

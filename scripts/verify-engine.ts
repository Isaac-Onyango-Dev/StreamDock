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
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { buildOutputTemplate, sanitizeName } from '../electron/smart-naming';
import { parseChangelog } from './lib/changelog';

const root = join(import.meta.dirname, '..');
let assertions = 0;

function assert(condition: boolean, message: string): void {
  assertions += 1;
  if (!condition) {
    throw new Error(message);
  }
}

/** Strip comments, so a check for code cannot be satisfied — or tripped — by prose about it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
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
  // The "Episode (N)" / "Season N" scheme these used to assert was abolished:
  // downloads are named after the real title the probe already resolved, and a
  // folder appears only for a confirmed playlist.
  assert(
    buildOutputTemplate({ mode: 'video', isPlaylist: true, folderHint: 'Road Trip' }) ===
      'Road Trip/%(title).150B.%(ext)s',
    'a confirmed playlist gets a named folder holding real per-item titles',
  );
  assert(
    buildOutputTemplate({ mode: 'video', playlistItems: '1-5' }) ===
      '%(playlist_title).150B/%(title).150B.%(ext)s',
    'playlist ranges fall back to playlist title metadata for the folder',
  );
  assert(
    buildOutputTemplate({ mode: 'video', titleHint: 'Some Episode' }) === 'Some Episode.%(ext)s',
    'a single video is named after its title with no folder wrapping',
  );
  for (const template of [
    buildOutputTemplate({ mode: 'video' }),
    buildOutputTemplate({ mode: 'video', isPlaylist: true }),
    buildOutputTemplate({ mode: 'video', folderHint: 'Demon Slayer' }),
  ]) {
    assert(
      !template.includes('Episode (') && !template.includes('season_number') &&
      !template.includes('playlist_index'),
      'no output template reintroduces the abolished episode/season numbering',
    );
  }
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
  assert(engineSource.includes('resolveOutputTemplate('), 'download engine builds the -o template from smart-naming');
  // The -o template must stay relative and be paired with --paths, or yt-dlp
  // ignores the staging directory and writes partials straight into the user's
  // download folder.
  assert(engineSource.includes("'--paths', `home:"), 'download engine passes the destination as --paths home:');
  assert(engineSource.includes("'--paths', `temp:"), 'download engine stages in-progress files under --paths temp:');
  assert(engineSource.includes('STAGING_DIR_NAME'), 'download engine has a dedicated staging directory');
  assert(engineSource.includes('clearStaging('), 'download engine clears staged partials when a download ends');
  assert(engineSource.includes('classifyEngineFailure('), 'download engine classifies failures through the shared classifier');
  assert(!engineSource.includes('toUserError(error)'), 'download engine no longer re-classifies failures without context');
  assert(engineSource.includes("'--retry-sleep', 'fragment:exp=1:10'"), 'download engine uses valid yt-dlp retry sleep syntax');
  assert(!engineSource.includes('fragment:exp=1:max=10'), 'download engine does not use invalid retry sleep max syntax');
  assert(mainSource.includes('resolveUpdatableYtDlpCommand()'), 'engine update uses a user-writable yt-dlp target');
  // The duplicated title-bar wordmark was this macOS-convention app-name menu
  // being added on every platform, then drawn as plain text by the in-window
  // menu bar beside the gradient wordmark. It must stay macOS-gated.
  assert(
    /const appNameMenu[^;]*?isMac[^;]*?\?/s.test(mainSource),
    'the app-name menu entry is macOS-only, so it cannot duplicate the wordmark',
  );
}

interface EpisodePatternConfig {
  hosts: string[];
  pathPattern: string;
  episodeParam?: string;
  nextPath?: string;
  titlePrefix?: string;
}

interface HostConfig {
  referenceHosts: string[];
  manifestProbeHosts: string[];
  animeHosts: string[];
  pluginExtractorHosts: string[];
  episodePatterns?: EpisodePatternConfig[];
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

/**
 * The published site must show every changelog bullet in full.
 *
 * build-site.ts used to re-parse the changelog's raw body lines with its own
 * `/^-\s+(.*)$/` match, which kept the first physical line of each bullet and
 * dropped the indented continuations under it. Since this repo hard-wraps
 * changelog prose, nearly every bullet shipped to the site cut off mid-sentence
 * ("...reported as a login wall. Both are"). The shared parser had always joined
 * those lines correctly; the site simply had a second, worse copy of the logic.
 *
 * This asserts the end state rather than the implementation, so it catches a
 * regression whatever reintroduces one.
 */
function verifyChangelogRendering(): void {
  const html = readProjectFile('docs/index.html');
  const section = html.match(/<section id="changelog"[\s\S]*?<\/section>/)?.[0];
  assert(Boolean(section), 'docs/index.html contains a #changelog section');
  if (!section) return;

  const rendered = [...section.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) =>
    m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  assert(rendered.length > 0, 'the rendered changelog has at least one bullet');

  const normalize = (text: string) => text.replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
  const entries = parseChangelog(readProjectFile('CHANGELOG.md')).slice(0, 3);
  const expected = entries.flatMap((entry) => entry.sections.flatMap((s) => s.items)).map(normalize);
  const got = rendered.map(normalize);

  const truncated = expected.filter(
    (item) => !got.includes(item) && got.some((line) => line.length < item.length && item.startsWith(line)),
  );
  assert(
    truncated.length === 0,
    `no changelog bullet is truncated on the site${truncated.length ? ` (first: "${truncated[0].slice(0, 60)}…")` : ''}`,
  );

  const missing = expected.filter((item) => !got.includes(item));
  assert(
    missing.length === 0,
    `every changelog bullet from the newest entries is rendered${missing.length ? ` (missing ${missing.length})` : ''}`,
  );

  // Section grouping: an entry with both "Fixed" and "Changed" must render both,
  // not collapse every bullet under whichever heading came first.
  const multiSection = entries.find((entry) => entry.sections.filter((s) => s.title).length > 1);
  if (multiSection) {
    for (const s of multiSection.sections.filter((x) => x.title)) {
      assert(
        section.includes(`<h3>${s.title}</h3>`),
        `v${multiSection.version}'s "${s.title}" section heading is rendered`,
      );
    }
  }
}

/**
 * The generated site must be fully substituted and structurally complete.
 *
 * Two failures this catches, both real:
 *
 *  - An unsubstituted `{{PLACEHOLDER}}` shipping to the live site. Every one of
 *    these is a typo between the template and build-site.ts, and the page
 *    renders the literal braces to visitors.
 *  - Content deleted during a bulk template edit. Swapping the platform icons
 *    with a regex whose `.*?` could backtrack across a sibling silently ate the
 *    entire "Nothing else to install" requirement card; the build succeeded and
 *    only a screenshot showed three cards where there had been four.
 */
function verifySiteRendering(): void {
  const html = readProjectFile('docs/index.html');

  const leftover = html.match(/\{\{[A-Z_]+\}\}/g);
  assert(
    leftover === null,
    `docs/index.html has no unsubstituted placeholders${leftover ? ` (found ${leftover.join(', ')})` : ''}`,
  );

  // The real Font Awesome brand marks, inlined from docs/assets/icons/. Their
  // viewBoxes are distinctive: a generic 24x24 icon here means a placeholder
  // glyph crept back in.
  const brandIcons: Array<[string, string]> = [
    ['Windows', '0 0 448 512'],
    ['Linux', '0 0 448 512'],
    ['Apple', '0 0 384 512'],
  ];
  for (const [label, viewBox] of brandIcons) {
    assert(
      html.includes(`viewBox="${viewBox}"`),
      `the site inlines the real ${label} brand icon (viewBox ${viewBox})`,
    );
  }

  // Each OS mark appears in the hero pill, the requirements grid and the
  // download card — three instances apiece.
  const appleCount = (html.match(/viewBox="0 0 384 512"/g) || []).length;
  assert(appleCount === 3, `the Apple mark appears 3 times, not ${appleCount}`);
  const wideCount = (html.match(/viewBox="0 0 448 512"/g) || []).length;
  assert(wideCount === 6, `the Windows and Linux marks appear 6 times combined, not ${wideCount}`);

  for (const heading of ['Windows', 'Nothing else to install', 'macOS', 'Linux']) {
    assert(
      html.includes(`<h5>${heading}`),
      `the System Requirements grid still lists "${heading}"`,
    );
  }

  // A platform is dimmed exactly when it cannot be downloaded.
  //
  // These two facts lived in different places and drifted: Linux kept an inline
  // opacity:.5 through its first release, so the platform that had just shipped
  // looked greyed out beside an undimmed macOS that had not. Tying the styling
  // to the download button means the next platform to ship cannot be left
  // looking unavailable.
  for (const platform of ['windows', 'mac', 'linux']) {
    const card = html.match(
      new RegExp(`<div class="([^"]*)"[^>]*data-platform-card="${platform}"`),
    );
    assert(card !== null, `the download grid has a card for ${platform}`);
    const downloadable = !(card?.[1] ?? '').includes('is-disabled');

    // The requirement item for this platform is found by the heading it carries.
    const label = platform === 'mac' ? 'macOS' : platform === 'windows' ? 'Windows' : 'Linux';
    const item = html.match(
      new RegExp(`<div class="req-item([^"]*)">(?:(?!</div>\\s*</div>)[\\s\\S])*?<h5>${label}`),
    );
    assert(item !== null, `the requirements grid has an entry for ${label}`);
    const dimmed = (item?.[1] ?? '').includes('is-pending');

    assert(
      dimmed !== downloadable,
      downloadable
        ? `${label} is downloadable, so its requirements entry is not dimmed`
        : `${label} is not downloadable, so its requirements entry is dimmed`,
    );
  }

  // The inline opacity this replaced must not come back.
  assert(
    !/class="req-item"[^>]*style="[^"]*opacity/.test(html),
    'no requirements entry carries an inline opacity (use .is-pending)',
  );
}

/**
 * The Linux icon must be installed at sizes the desktop can actually find.
 *
 * electron-builder downsamples a single PNG when producing a macOS .icns or a
 * Windows .ico, but for Linux it ships only the sizes it is handed. Pointing
 * `build.linux.icon` at the lone 1024x1024 assets/icon.png therefore installed
 * it to usr/share/icons/hicolor/1024x1024/ — a directory the freedesktop
 * hicolor index does not list, its largest being 512x512 — so `Icon=streamdock`
 * resolved to nothing and every Linux desktop drew a generic fallback icon.
 *
 * Asserted on the end state (what assets/icons/ contains and what package.json
 * points at) rather than on the generator, so any route back to a single-size
 * icon is caught.
 */
function verifyLinuxIcons(): void {
  const pkg = JSON.parse(readProjectFile('package.json')) as {
    build?: { linux?: { icon?: string } };
  };
  const configured = pkg.build?.linux?.icon;
  assert(
    configured === 'assets/icons',
    `build.linux.icon points at the multi-size directory, not ${String(configured)}`,
  );

  const dir = join(root, 'assets', 'icons');
  assert(existsSync(dir), 'assets/icons/ exists (run `npm run icons:build`)');

  const present = new Set(readdirSync(dir).filter((f) => f.endsWith('.png')));

  // 48 is what a GNOME/KDE launcher asks for most often; 256 covers HiDPI docks.
  // Both are indexed by hicolor, which is the property that actually matters.
  for (const size of [16, 32, 48, 64, 128, 256, 512]) {
    assert(
      present.has(`${size}x${size}.png`),
      `assets/icons/ ships an indexed ${size}x${size}.png`,
    );
  }

  // A size outside hicolor's index is invisible to the desktop, so shipping one
  // as the *only* icon is the bug this guard exists for.
  assert(
    !present.has('1024x1024.png'),
    'assets/icons/ contains no 1024x1024.png — hicolor does not index that size',
  );
}

/**
 * Exactly one module may decide what happens to subtitles.
 *
 * The shipped bug was not a wrong value, it was a second decider:
 * `applyLanguageAndSubtitleArgs` honoured the per-download picker and
 * `applyYtDlpOptions` then appended `--embed-subs` from a global setting whose
 * default was true — so "None" still embedded and "Sidecar" embedded as well.
 * The settings pass ran last, so it always won.
 *
 * A unit test on the pure builder cannot catch that, because the override lives
 * outside it. This asserts the structural property instead: the engine emits no
 * subtitle flags of its own, so nothing is in a position to contradict
 * shared/subtitle-args.ts.
 */
function verifySubtitleOwnership(): void {
  const engine = readProjectFile('electron/download-engine.ts');

  for (const flag of ['--embed-subs', '--write-subs', '--write-auto-subs', '--convert-subs', '--sub-langs']) {
    assert(
      !engine.includes(`'${flag}'`),
      `download-engine.ts emits no ${flag} of its own (subtitle flags belong to shared/subtitle-args.ts)`,
    );
  }

  const shared = readProjectFile('shared/subtitle-args.ts');
  assert(
    shared.includes("'--embed-subs'") && shared.includes("'--write-subs'"),
    'shared/subtitle-args.ts is the module that does emit them',
  );

  // Burned-in subtitles are destructive and deliberately unimplemented; they
  // must never appear as a side effect of an embed path.
  for (const source of [engine, shared]) {
    assert(!source.includes('-vf'), 'no filter-graph flag: subtitles are never burned into the picture');
  }
}

/**
 * The quality picker offers only resolutions a source actually reported.
 *
 * It used to fall back to a hardcoded 1080/720/480/360 ladder whenever nothing
 * had been detected — which is before Analyze runs, for every playlist, and for
 * every episode-range probe. The list a user saw was therefore usually not the
 * source's.
 */
/**
 * All four subtitle behaviours stay reachable from the picker.
 *
 * "None" in particular: the shipped bug embedded subtitles anyway, so the
 * option existing is the visible half of that fix. Asserted here rather than in
 * e2e because the picker sits behind a probe and a network-free run cannot
 * reach it — and a permanently-skipped test reads as coverage it is not.
 */
function verifySubtitleModesOffered(): void {
  const capture = readProjectFile('client/src/views/CaptureView/index.tsx');
  for (const mode of ['none', 'sidecar', 'embed', 'both']) {
    assert(
      capture.includes(`<option value="${mode}">`),
      `the Subtitles picker offers "${mode}"`,
    );
  }

  const settings = readProjectFile('client/src/views/SettingsView/YtDlpSettings.tsx');
  assert(
    !settings.includes("'embedSubs'"),
    'the settings panel sets a default subtitle mode, not the old global embedSubs override',
  );
}

function verifyNoFabricatedQualities(): void {
  const capture = readProjectFile('client/src/views/CaptureView/index.tsx');
  const quality = readProjectFile('client/src/lib/quality.ts');

  for (const [name, source] of [['CaptureView', capture], ['lib/quality', quality]] as const) {
    assert(
      !/\[\s*1080\s*,\s*720\s*,\s*480/.test(source),
      `${name} contains no hardcoded quality ladder`,
    );
  }

  // An explicit pick is a ceiling, not a requirement — an item lacking the
  // exact height is downgraded rather than skipped.
  assert(
    quality.includes('height<=') && !quality.includes('height='.replace('<', '')  + '$'),
    'quality selectors are built as height<= ceilings',
  );
}


/**
 * Episode patterns must live in the config, and must cover every host that is
 * routed as an anime source.
 *
 * They used to be two literal host regexes inside detectEpisodePattern.
 * anikototv.to appears in pluginExtractorHosts, manifestProbeHosts and
 * animeHosts and shares anikoto.cz's URL shape exactly, but was absent from
 * that function, so pasting the host Isaac actually uses never produced an
 * episode range. Asserting the shipped config here — the code-level behaviour
 * is covered by playlist-inspector.test.ts against the fallback config.
 */
function verifyEpisodePatterns(): void {
  const config = readHostConfig();
  const patterns = config.episodePatterns ?? [];

  assert(patterns.length > 0, 'host-config.json declares episode patterns as data');

  for (const pattern of patterns) {
    assert(
      Array.isArray(pattern.hosts) && pattern.hosts.length > 0,
      `episode pattern "${pattern.pathPattern}" names at least one host`,
    );
    // A pattern that compiles nowhere is dead config; catch it at build time
    // rather than silently skipping the host at runtime.
    let compiled: RegExp | null = null;
    try {
      compiled = new RegExp(pattern.pathPattern, 'i');
    } catch {
      compiled = null;
    }
    assert(compiled !== null, `episode pattern for ${pattern.hosts?.[0]} is a valid regex`);
    assert(
      pattern.pathPattern.includes('(?<series>'),
      `episode pattern for ${pattern.hosts?.[0]} exposes a series group`,
    );
    assert(
      Boolean(pattern.episodeParam) !== Boolean(pattern.nextPath),
      `episode pattern for ${pattern.hosts?.[0]} says exactly one way to reach the next episode`,
    );
    if (pattern.nextPath) {
      assert(
        pattern.pathPattern.includes('(?<episode>'),
        `path-numbered pattern for ${pattern.hosts?.[0]} exposes an episode group`,
      );
      assert(
        pattern.nextPath.includes('{episode}'),
        `nextPath for ${pattern.hosts?.[0]} substitutes the episode number`,
      );
    }
  }

  const covered = new Set(patterns.flatMap((pattern) => pattern.hosts ?? []));
  for (const host of ['anikoto.cz', 'anikototv.to', 'shuttletv.su']) {
    assert(covered.has(host), `${host} has an episode pattern`);
  }

  // The regression itself: both anikoto domains are routed identically
  // everywhere else, so neither may be left out of episode detection.
  for (const host of ['anikoto.cz', 'anikototv.to']) {
    assert(
      config.pluginExtractorHosts.includes(host) === covered.has(host),
      `${host} is routed and episode-detected consistently`,
    );
  }

  // Episode detection must not be reintroduced as literal hosts in code.
  const inspector = readProjectFile('electron/playlist-inspector.ts');
  const detector = inspector.slice(
    inspector.indexOf('export function detectEpisodePattern'),
    inspector.indexOf('interface SeriesInfo'),
  );
  assert(
    detector.includes('EPISODE_PATTERNS()'),
    'detectEpisodePattern reads its hosts from config',
  );
  for (const host of ['shuttletv.su', 'anikoto.cz', 'anikototv.to']) {
    assert(
      !detector.includes(`'${host}'`),
      `detectEpisodePattern does not hardcode ${host}`,
    );
  }
}

/**
 * One classifier answers "what language is this, and how do we know?".
 *
 * The probe used to guess from URL substrings and always return a label, which
 * the UI showed in the same badge as a language the manifest had declared — so
 * a guess drawn from a CDN path was indistinguishable from a fact. The shared
 * model carries a confidence, and the probe must not grow a private classifier
 * again.
 */
function verifyLanguageOwnership(): void {
  const probe = stripComments(readProjectFile('electron/stream-options-probe.ts'));

  assert(
    probe.includes("from '../shared/language'"),
    'stream-options-probe classifies languages through the shared model',
  );
  assert(
    !/function\s+classifyLanguage\s*\(/.test(probe),
    'stream-options-probe defines no private language classifier',
  );
  // The two substring tests that produced confident wrong answers.
  assert(
    !probe.includes("includes('hub')"),
    'stream-options-probe no longer treats "hub" as a language',
  );
  assert(
    !probe.includes("includes('en')"),
    'stream-options-probe no longer reads "en" out of arbitrary substrings',
  );

  const shared = readProjectFile('shared/language.ts');
  for (const state of ['declared', 'inferred', 'unknown']) {
    assert(shared.includes(`'${state}'`), `the language model distinguishes ${state} values`);
  }

  // The UI must actually act on the confidence, or carrying it changes nothing.
  const modal = readProjectFile('client/src/components/MediaLanguageSelectionModal.tsx');
  assert(
    modal.includes('languageConfidence'),
    'the stream picker distinguishes a declared language from a guess',
  );
}


/**
 * The Audio control must offer only what was detected, like the quality one.
 *
 * It shipped as a hardcoded Auto / English dub / Original list, rendered before
 * anything was analysed. Being built on `--format-sort lang:` it cannot take
 * effect unless the source carries two audio languages — and on the anime hosts
 * it never can, because they serve each language as its own manifest. So the
 * prominent control was the one that could not work, while the detected stream
 * options that do work were hidden behind a button.
 */
function verifyNoFabricatedAudioChoices(): void {
  const capture = stripComments(readProjectFile('client/src/views/CaptureView/index.tsx'));

  // The literal option list that used to sit in the markup.
  assert(
    !/<option value="dub">/.test(capture) && !/<option value="sub">/.test(capture),
    'CaptureView renders no hardcoded dub/sub audio options',
  );
  assert(
    capture.includes('buildAudioChoices('),
    'the Audio picker is built from detected audio tracks',
  );

  const audio = readProjectFile('client/src/lib/audio-choices.ts');
  assert(
    audio.includes('languages.size < 2'),
    'audio preferences need at least two detected languages to be offered',
  );

  // The working control has to be reachable without opening a dialog.
  assert(
    /aria-label="Language"/.test(capture),
    'detected language streams are offered in the main row, not only behind a button',
  );
}

verifySmartNaming();
verifyEngineWiring();
verifyRouteCoverage();
verifyEpisodePatterns();
verifyLanguageOwnership();
verifyChangelogRendering();
verifySiteRendering();
verifyLinuxIcons();
verifySubtitleOwnership();
verifySubtitleModesOffered();
verifyNoFabricatedQualities();
verifyNoFabricatedAudioChoices();

console.log(`StreamDock engine verification passed (${assertions} checks).`);

// Role: fail the build when the engines that are supposed to be bundled are not
// actually there — or are there but cannot run.
//
// This exists because "the build succeeded" has twice meant nothing:
//
//   - v1.1.0 shipped to users with an empty resources/binaries/. binaries/ is
//     gitignored and nothing called the download script, so electron-builder
//     packaged an app whose engines did not exist. The installer was ~102MB
//     when the engines alone are ~420MB; nobody noticed until the size was
//     compared against a later build.
//   - The same bug was latent for Linux right up until this check was written:
//     download-binaries.ts returned early on non-Windows with a clean exit, so
//     CI's Build Linux job packaged an AppImage with an empty binaries folder
//     and reported success.
//
// A packaging step cannot tell the difference between "no engines needed" and
// "engines missing". This can, so it runs between the download and the package.
import { execFileSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { join } from 'path';

const BINARIES_DIR = join(import.meta.dirname, '..', 'binaries');
const suffix = process.platform === 'win32' ? '.exe' : '';

/** Small enough that it cannot be a real engine — an HTML error page, a stub. */
const MIN_PLAUSIBLE_BYTES = 1_000_000;

interface Engine {
  name: string;
  /** Argument that makes it print a version and exit 0. */
  versionArg: string;
  /** Pattern the version output must match, to prove it is the real tool. */
  expect: RegExp;
}

const ENGINES: Engine[] = [
  { name: 'yt-dlp', versionArg: '--version', expect: /^\d{4}\.\d{2}\.\d{2}/ },
  { name: 'ffmpeg', versionArg: '-version', expect: /ffmpeg version/i },
  { name: 'ffprobe', versionArg: '-version', expect: /ffprobe version/i },
];

const failures: string[] = [];

for (const engine of ENGINES) {
  const fileName = `${engine.name}${suffix}`;
  const path = join(BINARIES_DIR, fileName);

  if (!existsSync(path)) {
    failures.push(`${fileName} is missing from binaries/. Run \`npm run download:binaries\`.`);
    continue;
  }

  const bytes = statSync(path).size;
  if (bytes < MIN_PLAUSIBLE_BYTES) {
    failures.push(
      `${fileName} is only ${(bytes / 1024).toFixed(0)}KB — too small to be the real engine. ` +
      `A failed download that wrote an error page would look like this.`,
    );
    continue;
  }

  // Present and plausibly sized is still not "works". A wrong-architecture
  // build, a file without the executable bit, or a truncated download all get
  // this far and fail only once a user tries to download something.
  try {
    const out = execFileSync(path, [engine.versionArg], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!engine.expect.test(out.trim())) {
      failures.push(`${fileName} ran but its version output was unrecognisable: ${out.trim().slice(0, 80)}`);
      continue;
    }
    console.log(`  ${fileName.padEnd(12)} ${(bytes / 1e6).toFixed(1).padStart(6)} MB  ${out.trim().split('\n')[0].slice(0, 60)}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    failures.push(`${fileName} exists (${(bytes / 1e6).toFixed(1)}MB) but could not be executed: ${reason}`);
  }
}

if (failures.length > 0) {
  console.error(`\nBundled engine check FAILED on ${process.platform}-${process.arch}:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error('\nPackaging now would ship an app that cannot download anything.\n');
  process.exit(1);
}

console.log(`\nBundled engine check passed on ${process.platform}-${process.arch}.`);

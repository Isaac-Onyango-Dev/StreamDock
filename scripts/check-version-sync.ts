// Role: the guardrail that makes version drift fail loudly instead of silently.
//
// The drift this exists to prevent: package.json advanced to 1.5.0 across three
// releases' worth of work while the newest published release stayed at v1.2.0,
// because bumping the version and pushing the tag were two separate manual acts
// and only the first was habitually performed. The site read package.json and
// advertised 1.4.0; the download button pointed at `releases/latest`, which
// still served the 1.2.0 installer. Users were offered a version that did not
// exist.
//
// The release workflow now creates the tag automatically from the version on
// main, so the tag can no longer be forgotten. This check covers what automation
// cannot: that the version is well-formed, documented, and never moves backwards.
//
// Deliberately does NOT require a tag to already exist for the current version —
// that would fail every version-bump commit before its own release could run.
import { execFileSync } from 'child_process';
import { parseChangelog, readProjectFile } from './lib/changelog';

interface Failure {
  check: string;
  detail: string;
}

const failures: Failure[] = [];
const fail = (check: string, detail: string) => failures.push({ check, detail });

const pkg = JSON.parse(readProjectFile('package.json')) as { version: string };
const version = pkg.version;

// ── 1. The version is valid semver ──────────────────────────────────────────
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
const parsed = version.match(SEMVER);
if (!parsed) {
  fail('semver', `package.json version "${version}" is not valid semver (x.y.z).`);
}

// ── 2. The version is documented ────────────────────────────────────────────
// A release whose notes nobody wrote is how a changelog rots into uselessness.
const entries = parseChangelog(readProjectFile('CHANGELOG.md'));
if (!entries.some((entry) => entry.version === version)) {
  fail(
    'changelog',
    `CHANGELOG.md has no "## [${version}] - <date>" section. ` +
    `Add one describing what shipped before bumping the version.`,
  );
}

// ── 3. The version never moves backwards ────────────────────────────────────
function toParts(value: string): [number, number, number] {
  const m = value.match(SEMVER);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

function compare(a: string, b: string): number {
  const [ax, ay, az] = toParts(a);
  const [bx, by, bz] = toParts(b);
  return ax - bx || ay - by || az - bz;
}

let tags: string[] = [];
try {
  tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf-8' })
    .split(/\r?\n/)
    .map((t) => t.trim().replace(/^v/, ''))
    .filter((t) => SEMVER.test(t));
} catch {
  // No git history available (a bare tarball, a shallow checkout without tags).
  // Skip rather than fail: this check is about ordering, and with no tags to
  // order against there is nothing to say.
  process.stderr.write('[check-version-sync] No git tags readable; skipping the ordering check.\n');
}

const highest = tags.sort(compare).at(-1);
if (highest && compare(version, highest) < 0) {
  fail(
    'ordering',
    `package.json is at ${version}, behind the newest released tag v${highest}. ` +
    `A published version must never be superseded by a lower one — electron-updater ` +
    `would offer existing users a downgrade.`,
  );
}

// ── Report ──────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  process.stderr.write(`\nVersion check failed (${failures.length}):\n\n`);
  for (const { check, detail } of failures) {
    process.stderr.write(`  [${check}] ${detail}\n`);
  }
  process.stderr.write('\n');
  process.exit(1);
}

const released = highest && compare(version, highest) === 0;
process.stdout.write(
  `Version check passed: package.json v${version}` +
  (highest ? `, newest tag v${highest}` : ', no tags yet') +
  (released ? ' (already released).' : ' (release pending — the Release workflow will tag it).') +
  '\n',
);

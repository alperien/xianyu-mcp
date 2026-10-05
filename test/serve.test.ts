/**
 * The spawn-time freshness gate: the launcher in front of every server start, and the verdict it asks.
 *
 * This is the enforcement point for a failure that ran for nine commits and then again for thirteen
 * minutes after being fixed. `git pull` fast-forwards the deployment, `git post-merge` does not fire
 * on a fast-forward, and the dist that answers is the one from before the pull -- answering plausibly,
 * with nothing in any of the answers saying otherwise. So the gate went where a spawn cannot be avoided
 * rather than where a pull could be policed, and this file is what says it actually closes.
 *
 * Three things are held here, in that order of importance:
 *
 *   - **A fresh spawn costs nothing.** The common case has to be a check and an exec, because the
 *     alternative is paying a guard's worth of tax on every session forever until somebody notices the
 *     tax. T1 asserts npm is never invoked and that the hot path still hands over the exit code.
 *   - **A stale dist is never served.** Not quietly, and not "just this once" -- T2 rebuilds, T3 and T4
 *     are the two ways the rebuild can fail to produce something servable, and both must refuse rather
 *     than start. T4 is the one worth having: a build that exits 0 and leaves a dist that cannot be
 *     shown to be current is not a success, and a launcher that believed the exit code would serve it.
 *   - **stdout stays clean.** This process stands between an MCP client and a JSON-RPC stream. One byte
 *     of diagnostics on the wrong fd presents as a client that cannot start, with the server's own
 *     error message pointing at nothing. T3 and T7 hold the channel.
 *
 * The launcher is copied into each throwaway repo rather than pointed at one, because it resolves the
 * checkout from its own location -- the same thing it does in production, where the path in
 * `opencode.json` is what makes it deploy-local. `src/build-info.ts` goes with it for the import.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type BuildInfo, serveVerdict } from '../src/build-info.ts';

const ROOT = resolve(import.meta.dirname, '..');
const SERVE = join(ROOT, 'scripts', 'serve.mjs');
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/**
 * A throwaway deployment: the launcher, the module it imports, and a `dist/` whose provenance is
 * whatever the test says it is.
 *
 * `stampCommit` is the interesting knob and it defaults to HEAD, because the common case is a dist
 * built from the checkout it sits in. Passing an older commit is the deployment that went stale: HEAD
 * moved under a `git pull`, and the bytes beside it are still the ones from before. There is no
 * `behind` argument on purpose -- this does not reproduce the remote-tracking half of the original
 * failure, which `test/check-deploy.test.ts` already owns; what is needed here is only that a spawn
 * can see the two commits disagree.
 */
const makeDeploy = (name: string, { stampCommit, git: withGit = true }: { stampCommit?: string; git?: boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), `xianyu-serve-${name}-`));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'dist'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'xianyu-mcp', version: '1.2.3', type: 'module' }));
  copyFileSync(join(ROOT, 'src', 'build-info.ts'), join(dir, 'src', 'build-info.ts'));
  copyFileSync(SERVE, join(dir, 'scripts', 'serve.mjs'));
  if (withGit) {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.invalid');
    git(dir, 'config', 'user.name', 'test');
  }
  // The sources exist either way -- an installed tarball has no git but does have a `src/`, and the
  // freshness comparison walks `src/` rather than asking git.
  for (const label of ['one', 'two']) {
    writeFileSync(join(dir, 'src', `${label}.ts`), `// ${label}\n`);
    if (withGit) { git(dir, 'add', '-A'); git(dir, 'commit', '-qm', label); }
  }
  if (withGit) git(dir, 'branch', 'origin/main', 'HEAD');
  // The dist. It prints to BOTH streams and to a marker file, because "did the server start" has to be
  // answerable after the fact on a channel the launcher does not control, and on one it does.
  writeFileSync(join(dir, 'dist', 'index.js'), [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync(process.env.SERVE_MARKER, 'served\\n');",
    "process.stdout.write('SERVER STDOUT\\n');",
    "process.stderr.write('SERVER STDERR\\n');",
    "process.exit(Number(process.env.SERVE_EXIT ?? 0));",
    '',
  ].join('\n'));
  if (withGit) {
    writeFileSync(join(dir, 'dist', 'build-info.json'), JSON.stringify({ version: '1.2.3', commit: stampCommit ?? git(dir, 'rev-parse', 'HEAD'), describe: 'v1.2.3', branch: 'main', dirty: false, built_at: new Date().toISOString() }));
  }
  // Pinned rather than left to the clock: `serveVerdict` compares these two as strings, and a dist
  // written in the same millisecond as its source would be a coin flip rather than a test. Half a
  // minute between them and both behind the current time, because what this has to be able to express
  // is a source edited after a build -- not a source dated in the year 2100.
  const hour = new Date(Date.now() - 3600_000);
  const half = new Date(Date.now() - 30_000);
  utimesSync(join(dir, 'src', 'build-info.ts'), hour, hour);
  utimesSync(join(dir, 'src', 'one.ts'), hour, hour);
  utimesSync(join(dir, 'src', 'two.ts'), hour, hour);
  utimesSync(join(dir, 'dist', 'index.js'), half, half);
  return { dir, head: withGit ? git(dir, 'rev-parse', 'HEAD') : '', cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

/**
 * A `npm` that does not exist, standing in for the real one.
 *
 * A stub rather than the real npm because these tests assert on *whether* a rebuild was attempted, and
 * an actual `npm ci` in a throwaway repo would either need the network or fail for reasons that have
 * nothing to do with the launcher. It logs every invocation, so "npm was never called" is checkable
 * rather than inferred from timing, and it can be told to fail or to write a genuinely fresh dist.
 */
const fakeNpm = (dir: string) => {
  const bin = join(dir, 'stub-bin');
  mkdirSync(bin, { recursive: true });
  const npm = join(bin, 'npm');
  writeFileSync(npm, [
    '#!/usr/bin/env node',
    // ESM, because the deployment's own package.json says "type": "module" and Node resolves the
    // nearest one for an extensionless file too. A CJS stub is a ReferenceError here, which is a
    // confusing way to find out.
    "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';",
    "import { execFileSync } from 'node:child_process';",
    "import { join } from 'node:path';",
    'const root = process.cwd();',
    'const args = process.argv.slice(2);',
    'appendFileSync(process.env.FAKE_NPM_LOG, `${args.join(" ")}\\n`);',
    "if (process.env.FAKE_NPM_FAIL === '1') { process.stderr.write('fake npm: the registry said no\\n'); process.exit(1); }",
    "if (args[0] === 'run' && args[1] === 'build' && process.env.FAKE_NPM_BUILD === '1') {",
    "  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();",
    "  mkdirSync(join(root, 'dist'), { recursive: true });",
    "  writeFileSync(join(root, 'dist', 'index.js'), \"import { writeFileSync } from 'node:fs';\\nwriteFileSync(process.env.SERVE_MARKER, 'served\\\\n');\\nprocess.stdout.write('SERVER STDOUT\\\\n');\\nprocess.stderr.write('SERVER STDERR\\\\n');\\nprocess.exit(Number(process.env.SERVE_EXIT ?? 0));\\n\");",
    "  writeFileSync(join(root, 'dist', 'build-info.json'), JSON.stringify({ version: '1.2.3', commit: head, describe: 'v1.2.3', branch: 'main', dirty: false, built_at: new Date().toISOString() }));",
    '}',
    'process.exit(0);',
    '',
  ].join('\n'));
  chmodSync(npm, 0o755);
  return npm;
};

const log = (p: string): string => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

/** The launcher's code with its comments stripped, so prose about what it avoids is not read as it doing it. */
const SERVE_CODE = readFileSync(SERVE, 'utf8')
  .split('\n')
  .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
  .join('\n');

/** Run the launcher in a deploy with a stubbed npm, returning both streams separately. */
const launch = (dir: string, { env = {} as Record<string, string>, args = ['--no-diagnose'] as string[] } = {}) => {
  const bin = join(dir, 'stub-bin');
  const npmLog = join(dir, 'npm.log');
  const marker = join(dir, 'served');
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'serve.mjs'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_NPM_LOG: npmLog, SERVE_MARKER: marker, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', npm: log(npmLog), marker: log(marker) };
};

// ---------------------------------------------------------------------------------------------
// serveVerdict: a pure function of stated facts, so the rules are stated here rather than inferred.

const info = (over: Partial<BuildInfo> = {}): BuildInfo => ({
  version: '1.0.0', commit: 'a'.repeat(40), describe: 'v1.0.0', branch: 'main', dirty: false,
  source: 'stamp', built_at: '2026-01-01T00:00:00.000Z', newest_source_at: '', base: 'origin/main',
  base_commit: 'b'.repeat(40), behind: 0, ahead: 0, stale: false, notes: [], ...over,
});

test('a build stamped with the commit it sits beside is servable', () => {
  const { ok, reasons } = serveVerdict(info(), 'a'.repeat(40));
  assert.equal(ok, true);
  assert.deepEqual(reasons, []);
});

test('a dist built from a different commit is not servable, and the reason names both', () => {
  // The pull that fast-forwarded without rebuilding. Both halves of the sentence, because "your dist
  // is stale" with nothing to paste into a bug report is how this spent nine commits unnoticed.
  const { ok, reasons } = serveVerdict(info(), 'c'.repeat(40));
  assert.equal(ok, false);
  assert.match(reasons.join(' '), /built from aaaaaaa and this checkout is at ccccccc/);
});

test('an unstamped dist is refused, because unstamped bytes cannot say what they are', () => {
  const { ok, reasons } = serveVerdict(info({ source: 'git', commit: 'c'.repeat(40) }), 'a'.repeat(40));
  assert.equal(ok, false);
  assert.match(reasons.join(' '), /carries no build-info\.json/);
});

test('there is no dist to serve', () => {
  const { ok, reasons } = serveVerdict(info({ built_at: '', newest_source_at: '' }), 'a'.repeat(40));
  assert.equal(ok, false);
  assert.match(reasons.join(' '), /no dist\/index\.js here to serve/);
});

test('a source file newer than the dist means the build predates the code beside it', () => {
  const { ok, reasons } = serveVerdict(info({ newest_source_at: '2026-01-01T00:00:01.000Z' }), 'a'.repeat(40));
  assert.equal(ok, false);
  assert.match(reasons.join(' '), /a source file is newer than dist\/index\.js/);
});

test('a dirty tree is not a stale dist, and treating it as one would rebuild forever', () => {
  // The rule that is not there. `deployVerdict` reads dirtiness off the stamp, and a rebuild of a
  // dirty tree stamps itself dirty again -- so a freshness check keyed on it would rebuild on every
  // single spawn, for a tree that is not stale. Once built, the dist *is* the tree, dirt included.
  const { ok } = serveVerdict(info({ dirty: true }), 'a'.repeat(40));
  assert.equal(ok, true, 'a dist built from this tree serves this tree, uncommitted or not');
  // And the dirt that does make a dist stale is still caught -- by mtime, because the source moved.
  assert.equal(serveVerdict(info({ dirty: true, newest_source_at: '2026-01-01T00:00:01.000Z' }), 'a'.repeat(40)).ok, false);
});

test('a source file dated in the future does not make the dist stale', () => {
  // A clock that disagrees with ours is not an edit made after the build. Believing it would rebuild
  // on every spawn for as long as the skew lasts, and each of those rebuilds lands at "now", which is
  // still older than the file -- so the loop would never end on its own.
  const { ok } = serveVerdict(info({ newest_source_at: '2099-01-01T00:00:00.000Z' }), 'a'.repeat(40), '2026-01-01T00:00:00.000Z');
  assert.equal(ok, true);
  // And the ceiling is a ceiling, not a way of switching the rule off: a timestamp inside the window
  // is still the drift it was before.
  assert.equal(serveVerdict(info({ newest_source_at: '2026-01-01T00:00:01.000Z' }), 'a'.repeat(40), '2026-01-01T00:00:02.000Z').ok, false);
});

test('a directory that is not a git checkout serves what is there rather than refusing', () => {
  // head '' is an installed tarball: there is no commit to disagree with, so the commit rules are
  // skipped instead of failed. Failing them would break the launcher in the one case where it has no
  // work to do.
  assert.equal(serveVerdict(info(), '').ok, true);
  // But a dist older than its own sources is still refused with no checkout to name.
  assert.equal(serveVerdict(info({ newest_source_at: '2026-01-01T00:00:01.000Z' }), '').ok, false);
});

// ---------------------------------------------------------------------------------------------
// The launcher itself.

test('a current build starts immediately: no npm, no wait, and the exit code is handed over', () => {
  const { dir, cleanup } = makeDeploy('fresh');
  try {
    fakeNpm(dir);
    const { code, stdout, stderr, npm, marker } = launch(dir, { env: { SERVE_EXIT: '7' } });
    assert.equal(npm, '', 'the hot path must not shell out to npm at all');
    assert.equal(marker, 'served\n', 'the server ran');
    assert.match(stdout, /SERVER STDOUT/, 'the server writes to the protocol channel and the launcher passes it through untouched');
    assert.match(stderr, /SERVER STDERR/);
    assert.doesNotMatch(stderr, /not the build of the tree/, stderr);
    assert.equal(code, 7, "a server's exit code is the launcher's exit code; an MCP client cannot tell the difference otherwise");
  } finally { cleanup(); }
});

test('a pull that left the dist behind rebuilds it, then serves', () => {
  const { dir, head, cleanup } = makeDeploy('pulled', { stampCommit: 'stale'.repeat(8).slice(0, 40) });
  try {
    fakeNpm(dir);
    const { code, stdout, stderr, npm, marker } = launch(dir, { env: { FAKE_NPM_BUILD: '1' } });
    assert.match(npm, /^ci\nrun build\n$/m, `npm ci then npm run build, in that order; got: ${JSON.stringify(npm)}`);
    assert.match(stderr, /was built from \w{7} and this checkout is at \w{7}/, 'the drift is named on the way past, not swallowed');
    assert.match(stderr, new RegExp(`rebuilt and verified`), stderr);
    assert.match(stdout, /SERVER STDOUT/);
    assert.equal(marker, 'served\n');
    assert.equal(code, 0);
    // The stub stamped what the real build stamps, so the dist now on disk is genuinely current --
    // asserted against git rather than against the launcher's own opinion of it.
    const stamp = JSON.parse(readFileSync(join(dir, 'dist', 'build-info.json'), 'utf8'));
    assert.equal(stamp.commit, head);
  } finally { cleanup(); }
});

test('a rebuild that fails refuses to start rather than serving what it could not replace', () => {
  const { dir, cleanup } = makeDeploy('brokenbuild', { stampCommit: 'stale'.repeat(8).slice(0, 40) });
  try {
    fakeNpm(dir);
    const { code, stdout, stderr, marker } = launch(dir, { env: { FAKE_NPM_FAIL: '1' } });
    assert.equal(code, 1);
    assert.equal(marker, '', 'the server must not have run');
    assert.equal(stdout, '', 'the protocol channel stays empty even when the launcher fails');
    assert.match(stderr, /REFUSING TO START/, stderr);
    assert.match(stderr, /installing dependencies exited 1/, 'the message says which step failed, not just that something did');
    assert.match(stderr, /npm ci && npm run build/, 'and says what to run');
    assert.match(stderr, /the registry said no/, 'npm\'s own output is passed through, so the real error is visible');
  } finally { cleanup(); }
});

test('a build that exits 0 and still leaves an unservable dist is refused', () => {
  // npm is told to succeed and is told not to write anything. A launcher that trusted the exit code
  // would start the server here, and the whole module exists because a plausible exit code is not
  // evidence that the bytes are right.
  const { dir, cleanup } = makeDeploy('nobuild', { stampCommit: 'stale'.repeat(8).slice(0, 40) });
  try {
    fakeNpm(dir);
    const { code, stdout, marker } = launch(dir);
    assert.equal(code, 1);
    assert.equal(marker, '', 'the server must not have run');
    assert.equal(stdout, '');
    assert.match(log(join(dir, 'npm.log')), /run build/, 'the build was attempted and is not what stopped it');
  } finally { cleanup(); }
});

test('a source edited after the last build is a stale dist, and rebuilds like one', () => {
  // The drift the stamp cannot see: the tree was clean when it was built, so the stamp still matches
  // HEAD, and then someone edited src without rebuilding. Only the mtime is left to say so, which is
  // why that comparison exists in the verdict at all. Two launches on one checkout, because the point
  // is the transition: served first, rebuilt after the edit.
  const { dir, cleanup } = makeDeploy('edit');
  try {
    fakeNpm(dir);
    const first = launch(dir);
    assert.equal(first.npm, '', `served without rebuilding while the build was current; npm ran: ${JSON.stringify(first.npm)}`);
    assert.equal(first.code, 0, first.stderr);
    writeFileSync(join(dir, 'src', 'two.ts'), '// edited after the build\n');
    const later = new Date(Date.now() - 5_000);
    utimesSync(join(dir, 'src', 'two.ts'), later, later);
    const { code, npm, stderr } = launch(dir, { env: { FAKE_NPM_BUILD: '1' } });
    assert.match(npm, /^ci\nrun build\n$/m, `an edit after the build is drift; npm ran: ${JSON.stringify(npm)}`);
    assert.equal(code, 0, stderr);
  } finally { cleanup(); }
});

test('a checkout with no dist at all is built rather than started', () => {
  // A fresh clone has no dist/index.js, which is not a stale deployment but the same problem with
  // nothing to serve. Same answer: build, then start.
  const { dir, cleanup } = makeDeploy('nodist');
  try {
    fakeNpm(dir);
    rmSync(join(dir, 'dist', 'index.js'));
    rmSync(join(dir, 'dist', 'build-info.json'));
    const { code, npm, marker, stderr } = launch(dir, { env: { FAKE_NPM_BUILD: '1' } });
    assert.match(npm, /^ci\nrun build\n$/m, `expected a build; got: ${JSON.stringify(npm)}`);
    assert.equal(marker, 'served\n', stderr);
    assert.equal(code, 0);
  } finally { cleanup(); }
});

test('a directory that is not a git checkout serves its dist without rebuilding', () => {
  const { dir, cleanup } = makeDeploy('nogit', { git: false });
  try {
    fakeNpm(dir);
    const { code, npm, marker } = launch(dir);
    assert.equal(npm, '', 'an installed tarball has no commit to be stale against, so there is nothing to do');
    assert.equal(marker, 'served\n');
    assert.equal(code, 0);
  } finally { cleanup(); }
});

test('the launcher asks the shared rules, and does not do its own commit arithmetic', () => {
  // A launcher with a second copy of "what counts as stale" would drift from `npm run check:deploy` and
  // from the `build` block `capabilities` reports -- and the three would eventually disagree about the
  // same directory. Asserted over the source, the same way check-deploy.test.ts holds its half.
  assert.match(SERVE_CODE, /import \{[^}]*serveVerdict[^}]*\} from '\.\.\/src\/build-info\.ts'/, 'the verdict is the shared one');
  assert.equal(/rev-list|--left-right|--count/.test(SERVE_CODE), false, 'the launcher must not do commit arithmetic');
  assert.match(SERVE_CODE, /scripts',\s*'check-deploy\.mjs'/, 'the full diagnosis, fetch and base and all, is the CLI that already knows how to do it');
});

test('nothing the launcher says goes to stdout', () => {
  // stdout is the JSON-RPC channel. A diagnostic written there does not look like a diagnostic: the
  // client sees a server that fails to start, and the error it reports points at its own parser.
  assert.equal(/console\.log|process\.stdout/.test(SERVE_CODE), false, 'the launcher must write to stderr only');
});
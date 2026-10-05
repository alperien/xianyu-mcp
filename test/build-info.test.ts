/**
 * Build provenance and the staleness verdict, driven against real throwaway git repositories.
 *
 * `deployVerdict` is a pure function of the numbers `buildInfo` gathered, and it is the part that
 * decides whether a deployment ships -- so it is tested over stated facts, with every case the
 * original failure could have taken written down as one. `buildInfo` is tested against repos made here
 * rather than against a fixture directory, because the thing worth proving is that the git plumbing
 * reads the orientation right: `rev-list --left-right --count` prints A-only first, and a swap turns a
 * stale deploy into a clean bill of health.
 *
 * The headline case is the one that actually happened: a checkout ten commits behind, whose own
 * remote-tracking ref was stale too, so the naive comparison reported zero drift. Both halves are
 * reproduced below, and the test fails if either reading is wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInfo, type BuildInfo, deployVerdict, packageRoot } from '../src/build-info.ts';
import { buildBlock } from '../src/build.ts';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** A repo with a shared history, a `main` to drift from, and a `dist/` to be stale about. */
const makeRepo = (name: string, { commits = 1, stamp = false, srcNewerThanDist = false } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), `xianyu-bi-${name}-`));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.invalid');
  git(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'xianyu-mcp', version: '9.9.9' }));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'dist'), { recursive: true });
  const commit = (label: string) => {
    writeFileSync(join(dir, 'src', `${label}.ts`), `// ${label}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', label);
  };
  for (let i = 0; i < commits; i++) commit(`c${i}`);
  const head = git(dir, 'rev-parse', 'HEAD');
  // A local remote-tracking ref, as every clone has. Without one the base does not resolve and every
  // comparison is `null` -- which the 'nobase' case below pins deliberately, and which would otherwise
  // make these tests pass for the wrong reason.
  git(dir, 'branch', 'origin/main', head);
  writeFileSync(join(dir, 'dist', 'index.js'), '// built\n');
  if (stamp) writeFileSync(join(dir, 'dist', 'build-info.json'), JSON.stringify({ version: '9.9.9', commit: head, describe: `v9.9.9-${commits}`, branch: 'main', dirty: false, built_at: new Date().toISOString() }));
  if (srcNewerThanDist) {
    const past = new Date(Date.now() - 3600_000);
    const future = new Date(Date.now() + 3600_000);
    utimesSync(join(dir, 'dist', 'index.js'), past, past);
    utimesSync(join(dir, 'src', 'c0.ts'), future, future);
  }
  return { dir, head, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

/** A complete BuildInfo to state facts against, so each rule is tested on its own. */
const info = (over: Partial<BuildInfo> = {}): BuildInfo => ({
  version: '1.0.0', commit: 'a'.repeat(40), describe: 'v1.0.0', branch: 'main', dirty: false,
  source: 'stamp', built_at: new Date().toISOString(), newest_source_at: '', base: 'origin/main',
  base_commit: 'a'.repeat(40), behind: 0, ahead: 0, stale: false, notes: [], ...over,
});

test('a build behind its base is stale, and the reason names both commits and the count', () => {
  const { ok, reasons } = deployVerdict(info({ behind: 9, ahead: 0, base_commit: 'b'.repeat(40), commit: 'a'.repeat(40) }));
  assert.equal(ok, false);
  // The whole point is that this sentence can be pasted into a bug report without anyone going to
  // look: which build, which base, how far.
  assert.match(reasons.join(' '), /built 9 commits behind origin\/main \(bbbbbbb\); aaaaaaa is what is running/);
});

test('one commit behind reads as one commit, not as a plural', () => {
  assert.match(deployVerdict(info({ behind: 1 })).reasons.join(' '), /built 1 commit behind/);
});

test('a build ahead of base is not drift', () => {
  // Mid-work is the normal state of a checkout, and failing it would make the check unusable in the
  // one place it is most useful. Only being behind base is the problem.
  const { ok, reasons } = deployVerdict(info({ behind: 0, ahead: 4 }));
  assert.equal(ok, true);
  assert.deepEqual(reasons, []);
});

test('could not measure is not the same as current', () => {
  // The failure this whole module exists for was invisible partly because an unmeasurable answer read
  // as a fine one. behind: null must fail the verdict, never pass it.
  const { ok, reasons } = deployVerdict(info({ behind: null, ahead: null, stale: null, base_commit: '' }));
  assert.equal(ok, false);
  assert.match(reasons.join(' '), /could not be measured, so it is unverified rather than current/);
});

test('an unstamped build and a dirty tree are both reported, not smoothed over', () => {
  assert.match(deployVerdict(info({ source: 'none', behind: 0 })).reasons.join(' '), /records no commit/);
  assert.match(deployVerdict(info({ dirty: true })).reasons.join(' '), /uncommitted changes/);
  assert.match(deployVerdict(info({ built_at: '' })).reasons.join(' '), /no dist\/ here to serve/);
});

test('a dist older than its own sources is caught even at the same commit', () => {
  // Commit comparison cannot see this one: both sides are the same commit and it still runs old code.
  const v = deployVerdict(info({ behind: 0, newest_source_at: new Date(Date.now() + 60_000).toISOString() }));
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(' '), /newer than dist\/index\.js/);
});

test('buildInfo reads orientation right: HEAD-only is ahead, base-only is behind', () => {
  const { dir, cleanup } = makeRepo('orient', { commits: 1, stamp: true });
  try {
    // Advance the base ref by two commits, behind this checkout's back -- no fetch, no origin. This is
    // the shape of the real deployment: a clone whose origin/main is itself stale.
    const base = git(dir, 'rev-parse', 'HEAD');
    writeFileSync(join(dir, 'src', 'x.ts'), '// x\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'x1');
    writeFileSync(join(dir, 'src', 'y.ts'), '// y\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'x2');
    git(dir, 'branch', '-f', 'origin/main', 'HEAD');

    const i = buildInfo(dir, 'origin/main');
    assert.equal(i.source, 'stamp', 'the stamp is preferred over the checkout it sits in');
    assert.equal(i.commit, base, 'the commit comes from the stamp, so a checkout that moved cannot rewrite it');
    assert.equal(i.behind, 2, 'base-only commits are behind');
    assert.equal(i.ahead, 0, 'this build is not ahead of the base');
    assert.equal(i.stale, true);
    assert.equal(deployVerdict(i).ok, false);

    // And the subject does not drift when the checkout does: pulling or committing into this directory
    // moves HEAD, and the build's own stamp does not move with it, so the comparison still describes
    // the bytes that would be served. This is the property that makes a stamp worth having over asking
    // git about the tree at read time.
    writeFileSync(join(dir, 'src', 'z.ts'), '// z\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'local');
    const after = buildInfo(dir, 'origin/main');
    assert.equal(after.commit, base, 'still the commit the build was made from');
    assert.equal(after.behind, 2, 'and still measured against the base, not against the new HEAD');
    assert.equal(after.ahead, 0);
    assert.match(after.notes.join(' '), /checkout has moved since the build/);

    // A build genuinely ahead of its base -- committed locally, not yet on main -- is not drift, and
    // must not fail the verdict: that is the normal state of a checkout mid-work, and failing it would
    // make the check useless exactly where it is most run.
    const localHead = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'branch', '-f', 'origin/main', `${localHead}~1`);
    // Rebuild, so dist is newer than the source it came from -- as it would be after `npm run build`.
    // Without this the mtime rule fires and the case measures the wrong rule.
    writeFileSync(join(dir, 'dist', 'index.js'), '// rebuilt\n');
    writeFileSync(join(dir, 'dist', 'build-info.json'), JSON.stringify({ version: '9.9.9', commit: localHead, describe: 'ahead', branch: 'main', dirty: false, built_at: new Date().toISOString() }));
    const local = buildInfo(dir, 'origin/main');
    assert.equal(local.behind, 0);
    assert.equal(local.ahead, 1);
    assert.equal(local.stale, false);
    assert.equal(deployVerdict(local).ok, true, 'a local build ahead of main is not a reason to refuse deployment');
  } finally { cleanup(); }
});

test('a stamp is preferred over the checkout, and an unstamped checkout still answers', () => {
  const stamped = makeRepo('stamped', { stamp: true });
  const bare = makeRepo('bare');
  try {
    assert.equal(buildInfo(stamped.dir).source, 'stamp');
    assert.equal(buildInfo(bare.dir).source, 'git');
    // The fallback still names a commit, and says which kind of answer it is -- an agent must be able
    // to tell "this is the recorded build" from "this is whatever the tree says right now".
    const i = buildInfo(bare.dir);
    assert.match(i.commit, /^[0-9a-f]{40}$/);
    assert.match(i.notes.join(' '), /no build-info\.json/);
    assert.equal(buildInfo(bare.dir).notes.some((n) => /not a git checkout/.test(n)), false);
  } finally { stamped.cleanup(); bare.cleanup(); }
});

test('a directory that is not a checkout says so instead of throwing', () => {
  const { dir, cleanup } = makeRepo('notgit');
  try {
    rmSync(join(dir, '.git'), { recursive: true, force: true });
    const i = buildInfo(dir, 'origin/main');
    assert.equal(i.source, 'none');
    assert.equal(i.stale, null, 'unmeasurable is null, not false');
    assert.equal(i.behind, null);
    assert.equal(deployVerdict(i).ok, false);
    assert.match(i.notes.join(' '), /not a git checkout/);
  } finally { cleanup(); }
});

test('a repo with no matching ref says so rather than reporting zero drift', () => {
  const { dir, cleanup } = makeRepo('nobase');
  try {
    const i = buildInfo(dir, 'origin/nonexistent');
    assert.equal(i.behind, null);
    assert.equal(i.base_commit, '');
    assert.equal(i.stale, null);
    assert.match(i.notes.join(' '), /does not resolve here/);
  } finally { cleanup(); }
});

test('version comes from package.json, and never from a literal in the source', () => {
  const { dir, cleanup } = makeRepo('version');
  try {
    // 9.9.9, which no release will ever carry: if this read a hardcoded number instead it would not
    // be 9.9.9. The same shape as the handshake-version test in invariants.test.ts.
    assert.equal(buildInfo(dir).version, '9.9.9');
  } finally { cleanup(); }
});

test('a source newer than the dist is caught from mtimes alone', () => {
  const { dir, cleanup } = makeRepo('mtime', { srcNewerThanDist: true });
  try {
    const v = deployVerdict(buildInfo(dir, 'origin/main'));
    assert.equal(v.ok, false);
    assert.match(v.reasons.join(' '), /newer than dist\/index\.js/);
  } finally { cleanup(); }
});

test('buildBlock carries the verdict an agent needs, and keeps unmeasured distinct from false', () => {
  const { dir, cleanup } = makeRepo('block', { stamp: true });
  try {
    const b = buildBlock(dir);
    assert.equal(b.version, '9.9.9');
    assert.match(b.commit, /^[0-9a-f]{40}$/);
    assert.equal(b.provenance, 'stamp');
    assert.equal(typeof b.deployable, 'boolean');
    assert.equal(b.stale, false);
    rmSync(join(dir, 'dist', 'build-info.json'));
    assert.equal(buildBlock(dir).provenance, 'git');
  } finally { cleanup(); }
});

test('packageRoot finds the package from inside dist/ or src/', () => {
  const { dir, cleanup } = makeRepo('root');
  try {
    assert.equal(packageRoot(join(dir, 'dist')), dir);
    assert.equal(packageRoot(join(dir, 'src')), dir);
    assert.equal(packageRoot(join(dir, 'dist', 'index.js')), dir);
  } finally { cleanup(); }
});

test('nothing here throws on a machine that cannot answer', () => {
  // The contract that keeps this usable on the capabilities path: every function returns a value for
  // a missing git, a missing dist, and a directory that is not a repository at all.
  assert.doesNotThrow(() => buildInfo('/nonexistent/path/deep'));
  assert.doesNotThrow(() => buildInfo(''));
  assert.doesNotThrow(() => packageRoot('/'));
  assert.doesNotThrow(() => deployVerdict(buildInfo('/nonexistent/path/deep')));
  assert.equal(buildInfo('/nonexistent/path/deep').source, 'none');
});
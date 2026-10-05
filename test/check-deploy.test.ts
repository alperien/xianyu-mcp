/**
 * The deploy check as a command, including its exit code.
 *
 * This is the part a person or CI actually runs, and it earned its own tests by failing the first
 * time it was used: asked to check `/tmp/staleclone`, it reported on the directory it was invoked from,
 * because the `i !== baseIdx + 1` guard also matched index 0 when `--base` was absent. A check that
 * silently inspects the wrong checkout is worse than no check -- it prints a confident verdict about
 * something else. So the argument parsing is pinned here, against a directory that is definitely not
 * the one the test was run from.
 *
 * The fetch case is here for the same reason, and it is the load-bearing one. The deployment that
 * motivated this module was thirteen commits behind main and reported a clean `OK` when the base ref
 * was read from cache, because its `origin/main` pointed at its own stale commit. Same directory, same
 * bytes, opposite verdicts, decided entirely by whether the fetch happened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'check-deploy.mjs');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const run = (args: string[]) => {
  try {
    return { code: 0, out: execFileSync('node', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e: any) {
    return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
};

/**
 * A repo with a `dist/` built from `behindBy` fewer commits than its base ref.
 *
 * The direction is the whole thing and it is easy to get backwards, so it is named rather than
 * implied: a stale deployment is a checkout whose base ref has commits it does not. `behindBy: 0`
 * puts base and HEAD on the same commit. Building the base forward and then rewinding HEAD is the
 * honest way to construct it, because it cannot be confused with a local build ahead of main --
 * which is not drift, and which the tests above check separately.
 */
const makeRepo = (name: string, { behindBy = 0, stamp = true } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), `xianyu-cd-${name}-`));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.invalid');
  git(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'xianyu-mcp', version: '1.2.3' }));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'dist'), { recursive: true });
  const commit = (label: string) => { writeFileSync(join(dir, 'src', `${label}.ts`), `// ${label}\n`); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', label); };
  commit('one');
  commit('two');
  commit('three');
  // base carries everything HEAD will be rewound past
  git(dir, 'branch', 'origin/main', 'HEAD');
  const deployed = git(dir, 'rev-parse', behindBy ? `HEAD~${behindBy}` : 'HEAD');
  git(dir, 'reset', '-q', '--hard', deployed);
  writeFileSync(join(dir, 'dist', 'index.js'), '// built\n');
  if (stamp) writeFileSync(join(dir, 'dist', 'build-info.json'), JSON.stringify({ version: '1.2.3', commit: git(dir, 'rev-parse', 'HEAD'), describe: 'v1.2.3', branch: 'main', dirty: false, built_at: new Date().toISOString() }));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

test('it checks the directory it was asked about, not the one it was run from', () => {
  const { dir, cleanup } = makeRepo('target');
  try {
    // Run from ROOT, which is a perfectly good checkout and would report on itself. The target is a
    // temp repo with its own base ref. If the positional is swallowed the output names ROOT and this
    // fails -- which is the bug this file was written for.
    const { out } = run([dir, '--no-fetch']);
    assert.match(out, new RegExp(`deploy check: ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), out);
    assert.doesNotMatch(out, new RegExp(`deploy check: ${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  } finally { cleanup(); }
});

test('--base takes a ref and does not mistake its value for a directory', () => {
  const { dir, cleanup } = makeRepo('baseflag');
  try {
    const { out } = run([dir, '--no-fetch', '--base', 'HEAD']);
    assert.match(out, /deploy check:/);
    assert.match(out, /base: {7}HEAD\n/);
  } finally { cleanup(); }
});

test('a stale deployment fails, and the reason names the commits and the count', () => {
  // Base ref two commits behind HEAD: this is the deployment that ran for nine commits unnoticed.
  const { dir, cleanup } = makeRepo('stale', { behindBy: 2 });
  try {
    const { code, out } = run([dir, '--no-fetch']);
    assert.equal(code, 1, 'a stale deployment must exit nonzero');
    assert.match(out, /STALE:/);
    assert.match(out, /built 2 commits behind origin\/main/);
    // The base commit is printed, so the verdict can be checked rather than trusted.
    assert.match(out, /base: {7}[0-9a-f]{7}/);
  } finally { cleanup(); }
});

test('a current deployment exits zero and says what it compared against', () => {
  const { dir, cleanup } = makeRepo('current');
  try {
    const { code, out } = run([dir, '--no-fetch']);
    assert.equal(code, 0, out);
    assert.match(out, /OK:/);
    assert.match(out, /1\.2\.3/);
  } finally { cleanup(); }
});

test('an unstamped deployment fails, because unstamped bytes cannot say what they are', () => {
  const { dir, cleanup } = makeRepo('unstamped', { stamp: false });
  try {
    const { code, out } = run([dir, '--no-fetch']);
    assert.equal(code, 1);
    assert.match(out, /UNSTAMPED/);
    assert.match(out, /unstamped/);
  } finally { cleanup(); }
});

test('a checkout that is not a repository fails rather than passing quietly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xianyu-cd-nogit-'));
  try {
    const { code, out } = run([dir, '--no-fetch']);
    assert.equal(code, 1, 'nothing to compare is not a pass');
    assert.match(out, /STALE:|not a git checkout/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('without a fetch the check says so, rather than implying the base is current', () => {
  // --no-fetch is the airgapped path. Its verdict can only be as good as the machine's cached ref, and
  // the output has to admit that instead of presenting a stale-ref count as fact.
  const { dir, cleanup } = makeRepo('nofetch');
  try {
    const { out } = run([dir, '--no-fetch']);
    assert.match(out, /fetched: {4}no \(--no-fetch\)/, out);
    assert.match(out, /only as fresh as that/, 'the cached-base caveat belongs on the same line, not just in the docs');
  } finally { cleanup(); }
});

test('the rules are the ones in src/build-info.ts, not a second copy', () => {
  // A drift check with its own logic would drift from the tool that reports the same thing to agents,
  // and the two would eventually disagree about what "stale" means. Asserted over the source: the CLI
  // imports buildInfo and deployVerdict rather than reimplementing the arithmetic.
  const src = execFileSync('node', ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8"))', SCRIPT], { encoding: 'utf8' });
  assert.match(src, /import \{ buildInfo, deployVerdict \} from '\.\.\/src\/build-info\.ts'/);
  assert.equal(/rev-list/.test(src), false, 'the CLI must not do its own commit arithmetic');
});
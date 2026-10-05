/**
 * Stamp the build with the commit it came from, so a deployed `dist/` can say what it is.
 *
 * This is the write half of src/build-info.ts, kept out of it because it runs at build time in a
 * checkout and is never on the serving path. `npm run build` calls it after `tsc`; nothing imports it.
 *
 * Why a stamp rather than asking git at runtime: the checkout moves. The deployment that motivated
 * this pointed at a directory that later advanced, so "what commit is this dist" answered from the
 * tree would change without the bytes changing. The stamp travels with the build, which is the only
 * place the question can be answered correctly.
 *
 * The commit is written even when the tree is dirty, and the dirtiness is written beside it. A build
 * of uncommitted work is a real thing people do; what is not acceptable is that it reads as a clean
 * commit, so `dirty` is recorded rather than the stamp being skipped.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? process.cwd());

/** '' rather than a throw: a build from a tarball, or on a machine without git, still deserves a stamp. */
const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

const commit = git(['rev-parse', 'HEAD']);
if (!commit) {
  process.stderr.write('stamp-build: no git checkout here, so the build is going out unstamped -- build-info.ts will report that rather than guess a commit\n');
  process.exit(0);
}

const version = (() => {
  try {
    return String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? '');
  } catch {
    return '';
  }
})();

const stamp = {
  version,
  commit,
  describe: git(['describe', '--tags', '--always', '--dirty']),
  branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
  dirty: git(['status', '--porcelain']).length > 0,
  built_at: new Date().toISOString(),
};

writeFileSync(join(root, 'dist', 'build-info.json'), `${JSON.stringify(stamp, null, 2)}\n`);
process.stderr.write(`stamp-build: ${stamp.commit.slice(0, 7)} (${stamp.describe})${stamp.dirty ? ' [dirty]' : ''}\n`);
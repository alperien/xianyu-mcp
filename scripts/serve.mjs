/**
 * Start the server, and never start one that is not the build of the tree it sits in.
 *
 * Point an MCP client at this instead of at `node dist/index.js` and the server cannot come up
 * serving stale bytes. The failure it exists for: `/home/user/xianyu-mcp-ts` was fast-forwarded with
 * `git pull`, `git post-merge` does not fire on a fast-forward so nothing rebuilt, and thirteen
 * minutes later a deployment was fixed and had already gone stale again. Every tool answered, every
 * answer was plausible, and nothing said so. A pull cannot fix that by failing -- a pull has to be
 * allowed to succeed, and the rebuild has to happen somewhere else.
 *
 * The spawn is that somewhere else, and it is the only place it can be. This is a local stdio MCP
 * server: there is no long-lived process, so there is no restart event to hang a rebuild on and no
 * moment at which anything would notice a pull had happened. Every session is an independent spawn,
 * and every spawn sees both facts at once -- the tree is at commit X, the dist claims commit Y. No
 * other chokepoint in the system sees both.
 *
 * The shape of it, in order:
 *
 *   1. read the local facts (`buildInfo` with no base ref, so no network) and ask `serveVerdict`,
 *   2. if the verdict is ok, exec the server. That is the whole hot path: two process spawns of
 *      `git`, a stat, a walk of `src/`. No fetch, no rebuild, no lock, nothing to wait on.
 *   3. otherwise say which fact failed, get the full diagnosis from `scripts/check-deploy.mjs` (which
 *      does fetch, and names the base it compared against), then `npm ci && npm run build`,
 *   4. re-ask. A build that ran and still cannot be shown current is refused rather than served,
 *   5. only then exec.
 *
 * Step 4 is the answer to "should a pull into that checkout fail loudly". A loud failure costs one
 * session; a silently stale dist costs every session in the drift window, and nothing in any of them
 * can tell which ones those were. So: never start serving something that has not been verified. That
 * also means there is no `--force` and no env var to skip it -- a deliberate escape hatch is a
 * `# set XIANYU_SERVE_STALE=1` waiting to be in somebody's environment permanently.
 *
 * Every line here goes to stderr. stdout is the JSON-RPC channel, and a launcher that logs one byte
 * to it corrupts the protocol in a way that presents as an MCP client failing to start, with nothing
 * in the client's error pointing at the server.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { buildInfo, packageRoot, serveVerdict } from '../src/build-info.ts';

const USAGE = `usage: node scripts/serve.mjs [--no-diagnose] [server args...]

  --no-diagnose   skip scripts/check-deploy.mjs when a rebuild is needed. The rebuild path already
                  costs a network round trip to npm, so the diagnosis is normally free next to it;
                  this is for the airgapped machine, where the fetch would sit there timing out.

Anything else is passed through to dist/index.js untouched.`;

/** stderr, always. See the note above -- stdout is the protocol. */
const say = (line = '') => process.stderr.write(`${line}\n`);

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  say(USAGE);
  process.exit(0);
}
const diagnose = !argv.includes('--no-diagnose');
const serverArgs = argv.filter((a) => a !== '--no-diagnose');

const root = packageRoot(import.meta.dirname);
if (!root) {
  say('serve: no xianyu-mcp package.json above this script, so there is nothing to serve. Run it from a clone of the repository.');
  process.exit(1);
}
const entry = join(root, 'dist', 'index.js');

/** '' for a directory that is not a git checkout, which is the installed-tarball case. */
const head = () => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

/** The check, and nothing else: no base ref, so no rev-list and no network. */
const check = () => serveVerdict(buildInfo(root, ''), head());

/**
 * Hand the process over to the server.
 *
 * `spawnSync` with inherited stdio rather than anything cleverer: the fds are the same ones the MCP
 * client opened, so the server owns the channel directly and there is nothing to pump or translate. A
 * child killed by a signal is re-raised here, so the launcher reports the death the server actually
 * had instead of flattening every one of them to exit 1 -- an MCP client that shuts a server down
 * should not read it as a crash.
 */
const execServer = () => {
  const child = spawnSync(process.execPath, [entry, ...serverArgs], { cwd: root, stdio: 'inherit' });
  if (child.error) {
    say(`serve: could not run ${entry}: ${child.error.message}`);
    process.exit(1);
  }
  if (child.signal) {
    say(`serve: the server was killed by ${child.signal}`);
    process.kill(process.pid, child.signal);
  }
  process.exit(child.status ?? 1);
};

/** Refuse, in words that say what to do next. Anything served from here has been verified above. */
const refuse = (reasons, detail) => {
  say();
  say(`serve: REFUSING TO START -- ${root}/dist/index.js is not the build of the tree beside it.`);
  for (const r of reasons) say(`  - ${r}`);
  if (detail) for (const line of detail.split('\n')) if (line.trim()) say(`  ${line}`);
  say();
  say(`Fix it: cd ${root} && npm ci && npm run build, then start again.`);
  say('Running that by hand works the same way -- this check keeps no state, so the next start looks again.');
  say('This will not start on a dist that cannot be shown to be the current build -- see scripts/serve.mjs.');
  process.exit(1);
};

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const run = (label, args) => {
  say();
  say(`serve: ${label} (${[npm, ...args].join(' ')})`);
  const r = spawnSync(npm, args, { cwd: root, stdio: 'inherit' });
  if (r.error) return `${label} could not be started at all: ${r.error.message}`;
  if (r.status !== 0) return `${label} exited ${r.status}. Its output is above.`;
  return '';
};

const hot = check();
if (hot.ok) execServer();

say(`serve: ${entry} is not the build of the tree beside it:`);
for (const r of hot.reasons) say(`  - ${r}`);

// Re-read once before doing anything expensive. The facts above come off a live filesystem, and the
// way they lie is a concurrent `npm run build` in this same directory: a half-written dist/index.js
// and no stamp yet read as "nothing here to serve", which would send every session spawned during
// somebody else's rebuild into its own npm ci. One more read catches the build that finished in the
// gap, and costs a few milliseconds on the path that is about to spend a minute in npm anyway.
const settled = check();
if (settled.ok) {
  say('serve: re-read and it is current after all -- the tree was mid-build a moment ago. Starting it.');
  execServer();
}

if (diagnose) {
  // The full answer rather than the local one: check-deploy fetches, names the base it compared
  // against, and reports how far behind main this is. The local verdict above cannot say any of that,
  // and "your dist is old" without "and main has moved nine commits since" is the sentence that sends
  // someone looking in the wrong direction. Its output is captured and reprinted on stderr because
  // this file's stdout is not available to it.
  const d = spawnSync(process.execPath, [join(root, 'scripts', 'check-deploy.mjs'), root], { cwd: root, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!d.error && d.stdout?.trim()) say(`\n${d.stdout.trim()}`);
  if (d.error) say(`serve: the deploy check could not run (${d.error.message}); continuing with the local reasons above.`);
}

const failure = run('installing dependencies', ['ci']) || run('building', ['run', 'build']);
if (failure) refuse(settled.reasons, failure);

// The build ran and may still not be servable: no git to stamp it, a dist the build did not write, a
// source touched while tsc ran. Asking again is the difference between "the rebuild succeeded" and
// "there is now a current build", which are not the same claim, and the claim is the whole point.
const after = check();
if (!after.ok) refuse(after.reasons, 'the rebuild finished, and the result still cannot be shown to be the current build.');

say('serve: rebuilt and verified. Starting it.');
execServer();
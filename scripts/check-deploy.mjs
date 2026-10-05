/**
 * Is the build being served the build that is current? Exits nonzero when it is not.
 *
 * This is the check for the failure that ran for nine commits unnoticed: opencode.json pointed the
 * xianyu MCP server at a `dist/` built from a checkout ten commits behind `main`, every tool answered
 * plausibly, and nothing anywhere said so. Run it before trusting a deployed server, and in CI so the
 * answer is never a surprise.
 *
 * Usage:
 *   node scripts/check-deploy.mjs [dir]        # default: this checkout
 *   node scripts/check-deploy.mjs --no-fetch   # compare against the cached ref only
 *   node scripts/check-deploy.mjs --base main  # compare against something other than origin/main
 *
 * `--no-fetch` is the default's opposite and is the interesting one. The drift this exists to catch
 * included the remote-tracking ref being stale too, so comparing HEAD against a cached `origin/main`
 * reported "0 behind" for a deploy that was ten commits behind. The default therefore fetches first
 * and says so; `--no-fetch` is for airgapped machines, where the printed base commit is the thing to
 * read instead of the verdict.
 *
 * The measurement itself lives in src/build-info.ts, imported here rather than reimplemented. The
 * rules that decide staleness are in one place, tested once, and used both by this CLI and by the
 * `capabilities` tool -- so the thing an agent reads at runtime and the thing CI runs cannot disagree
 * about what "stale" means.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { buildInfo, deployVerdict } from '../src/build-info.ts';

const argv = process.argv.slice(2);
const baseIdx = argv.indexOf('--base');
const base = baseIdx === -1 ? 'origin/main' : argv[baseIdx + 1] ?? 'origin/main';
// The base's value is consumed by --base and is not a directory, so it must not be picked up as one.
// `baseIdx + 1` is that index, and when --base is absent it is 0 -- which would swallow the first
// positional and silently check the wrong directory. Measured, not reasoned about: this shipped once
// pointing at the rig while asked about the deployment.
const rootArg = argv.filter((a, i) => !a.startsWith('--') && !(baseIdx !== -1 && i === baseIdx + 1));
const root = resolve(rootArg[0] ?? process.cwd());
const say = (line = '') => process.stdout.write(`${line}\n`);

const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return String(e?.stderr || e?.message || e).trim().split('\n')[0];
  }
};

say(`deploy check: ${root}`);
say(`  base:       ${base}`);

// Fetch first, always, unless told not to. This is the whole difference between a check that works and
// one that reports a confident zero: `origin/main` is a local file, and a stale clone has one too.
const skipFetch = argv.includes('--no-fetch');
let fetched = false;
if (skipFetch) {
  // Stated even when the ref happens to resolve, because "I did not look" and "I looked and it is
  // fine" are different claims and the output above cannot tell them apart on its own.
  say('  fetched:    no (--no-fetch) -- the base below is whatever this machine last cached, so the verdict is only as fresh as that');
}
if (!skipFetch) {
  const remoteRef = base.includes('/') ? base.split('/').pop() : base;
  try {
    execFileSync('git', ['fetch', '--quiet', 'origin', remoteRef], { cwd: root, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    fetched = true;
    say('  fetched:    yes');
  } catch (e) {
    say(`  fetched:    NO -- ${String(e?.stderr || e?.message || e).trim().split('\n')[0]}`);
    say('             the base ref below is whatever this machine last cached, so the verdict is only as fresh as that');
  }
}

const describe = git(['describe', '--tags', '--always', '--dirty']);
say(`  HEAD:       ${describe || '(unreadable)'}`);

const info = buildInfo(root, base);
say(`  version:    ${info.version || '(unreadable)'}`);
say(`  base:       ${info.base_commit ? `${info.base_commit.slice(0, 7)}  (${info.ahead} ahead, ${info.behind} behind)` : `${base} does not resolve here`}`);
say(`  serving:    ${info.source === 'stamp' ? `stamp ${info.commit.slice(0, 7)} built ${info.built_at}` : info.source === 'git' ? `checkout ${info.commit.slice(0, 7)}, UNSTAMPED` : 'no commit recorded at all'}`);
if (info.built_at) say(`  mtimes:     dist ${info.built_at}  newest src ${info.newest_source_at || '(none found)'}`);
for (const note of info.notes) say(`  note:       ${note}`);

const { ok, reasons } = deployVerdict(info);
say();
if (ok) {
  say(`OK: ${root} is current with ${base} and serving the build it says it is.`);
  process.exit(0);
}
say(`STALE: ${root}`);
for (const r of reasons) say(`  - ${r}`);
say();
say(`To fix: git pull && npm ci && npm run build --prefix ${root}`);
process.exit(1);
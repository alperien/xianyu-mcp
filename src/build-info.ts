/**
 * Which build is running, and is it the build anybody is looking at.
 *
 * This exists because of a failure that was invisible for nine commits. `opencode.json` pointed the
 * xianyu MCP server at `node /home/user/xianyu-mcp-ts/dist/index.js`, and that path was a checkout
 * of this same repository sitting ten commits behind `main` with a `dist/` built from it. Nothing
 * errored. Every tool answered, every answer was plausible, and `capabilities` described a search
 * surface the code no longer had. The staleness was only discoverable by asking a human to compare
 * two directories.
 *
 * So the build states its own commit, and the comparison is made where the answers are already being
 * read. Two halves, deliberately:
 *
 *   - `stampBuild` (scripts/stamp-build.mjs, run by `npm run build`) writes `dist/build-info.json`
 *     at build time. This is the half that makes the failure *nameable*: a checkout with no stamp was
 *     built by something that never recorded a commit, which is itself the finding. Reading the stamp
 *     rather than asking git about the working tree is what makes the answer survive the checkout
 *     moving underneath it.
 *   - everything here reads that stamp, falls back to the enclosing git checkout, and compares against
 *     a base ref.
 *
 * The trap worth naming, because it is the reason a naive version of this check reports a clean bill
 * on a stale deploy: `git rev-list HEAD...origin/main` counts commits against the *local remote-tracking
 * ref*, which is just another cached file. In the deploy that had drifted, that ref pointed at the old
 * commit too, so HEAD and `origin/main` agreed exactly and the count was a confident zero. A check that
 * does not fetch cannot see the drift it is looking for. `compareToBase` therefore reports the commit
 * it compared against and whether anything was fetched, and the CLI does the fetching.
 *
 * Nothing here throws. This module is read on the `capabilities` path, which is documented never to
 * raise even when the browser is gone, and a machine with no git, no `dist/`, or a half-installed
 * checkout must still get an answer rather than an error -- a refusal to describe the build is exactly
 * the silence this was written to end.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface BuildStamp {
  /** package.json's version, so the stamp and the MCP handshake cannot disagree. */
  version?: string;
  commit?: string;
  describe?: string;
  branch?: string;
  /** Uncommitted changes at stamp time: the build may not match the commit beside it. */
  dirty?: boolean;
  /** ISO 8601. When the build ran, which is not the same as when the sources last changed. */
  built_at?: string;
}

export interface BuildInfo {
  /** package.json's version, or '' if it could not be read. Never a literal, for the reason index.ts documents. */
  version: string;
  /** The full commit this build came from, or '' when nothing recorded one. */
  commit: string;
  /** `git describe` at stamp time, e.g. `v0.1.0-10-g8ff22ce`. Shown because it is the one form that names both a release and the distance from it. */
  describe: string;
  branch: string;
  dirty: boolean | null;
  /** Where the answer came from: the build's own stamp, or the checkout it is sitting in. */
  source: 'stamp' | 'git' | 'none';
  /** ISO 8601 mtime of the entry point, or '' when there is no `dist/`. */
  built_at: string;
  /** ISO 8601 mtime of the newest source file, or ''. Compared against `built_at` to catch a dist built before its own sources. */
  newest_source_at: string;
  /** The ref the comparison below was made against. */
  base: string;
  /** The commit that ref resolved to, or '' when it does not resolve. Named so a clean verdict can be checked. */
  base_commit: string;
  /** Commits on base but not on this build. `null` when unknown -- which is not zero. */
  behind: number | null;
  /** Commits on this build but not on base: a local build ahead of main is normal mid-work and is not drift. */
  ahead: number | null;
  /** True when this build is known to be older than base. The headline number. */
  stale: boolean | null;
  /** Anything that made the answer partial, in plain words. Empty means the answer is complete. */
  notes: string[];
}

const GIT_TIMEOUT_MS = 5000;

/** Run git and return stdout, or '' on any failure whatsoever. A missing git, a directory that is not
 *  a checkout, a lock held by a concurrent fetch: all of them mean "no answer", never an exception. */
const git = (cwd: string, args: string[]): string => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

const mtime = (path: string): string => {
  try {
    return new Date(statSync(path).mtimeMs).toISOString();
  } catch {
    return '';
  }
};

/** The newest mtime under `src/`, so "the dist predates its own sources" is a measurement rather than a guess. */
const newestSource = (root: string): string => {
  let newest = 0;
  try {
    for (const entry of readdirSync(join(root, 'src'), { recursive: true })) {
      if (typeof entry !== 'string' || !entry.endsWith('.ts')) continue;
      try { newest = Math.max(newest, statSync(join(root, 'src', entry)).mtimeMs); } catch { /* a file that vanished mid-walk */ }
    }
  } catch {
    return '';
  }
  return newest ? new Date(newest).toISOString() : '';
};

/** Walk up from the running module to the directory holding this package's `package.json`, so the
 *  stamp is found from `dist/` and from `src/` alike -- and from an installed tarball, where `dist/`
 *  is the whole thing. */
export const packageRoot = (from: string): string => {
  let dir = resolve(from);
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg?.name === 'xianyu-mcp') return dir;
    } catch { /* keep walking: no package.json here, or it is not ours */ }
    const up = dirname(dir);
    if (up === dir) return '';
    dir = up;
  }
};

const readStamp = (root: string): BuildStamp | null => {
  if (!root) return null;
  try {
    return JSON.parse(readFileSync(join(root, 'dist', 'build-info.json'), 'utf8')) as BuildStamp;
  } catch {
    return null;
  }
};

const readVersion = (root: string): string => {
  if (!root) return '';
  try {
    return String((JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? '');
  } catch {
    return '';
  }
};

/** Ask the enclosing checkout what it is. Used when no stamp exists, which is the pre-stamp build and
 *  the deployed checkout of a tarball -- and which is why an unstamped build reports `git`, not `stamp`. */
const fromGit = (root: string): BuildStamp => ({
  commit: git(root, ['rev-parse', 'HEAD']),
  describe: git(root, ['describe', '--tags', '--always', '--dirty']),
  branch: git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
  dirty: git(root, ['status', '--porcelain']) ? true : undefined,
});

/**
 * Everything known about the build rooted at `root`, and how far it is behind `base`.
 *
 * `base` defaults to `origin/main`, and the comparison is against the local remote-tracking ref --
 * which is a cache, not the remote. That is why `notes` says so when it could not fetch, and why
 * `scripts/check-deploy.mjs` fetches before calling this. A caller that wants a trustworthy `behind`
 * must fetch; a caller that wants a cheap answer gets one that is explicitly labelled as resting on
 * a cached ref.
 *
 * `base` may also be `''`, which asks for no comparison at all. That is for `scripts/serve.mjs`,
 * which sits in front of every server start and needs only the local facts -- `behind` is then `null`
 * and a note says it was not asked for, because the module's standing rule is that an unmeasured
 * thing is not a verified thing, and silently leaving `behind: 0` would break it.
 */
export const buildInfo = (root: string = packageRoot(import.meta.dirname), base = 'origin/main'): BuildInfo => {
  const notes: string[] = [];
  const version = readVersion(root);
  const entry = root ? join(root, 'dist', 'index.js') : '';
  const stamp = readStamp(root);
  const source: BuildInfo['source'] = stamp?.commit ? 'stamp' : root && git(root, ['rev-parse', 'HEAD']) ? 'git' : 'none';
  const facts = source === 'stamp' ? stamp! : source === 'git' ? fromGit(root) : {};

  if (source === 'none') notes.push(root
    ? 'this copy records no build stamp and is not a git checkout, so its commit cannot be named'
    : 'no xianyu-mcp package.json above this module, so this is not a checkout of the repository');
  else if (source === 'git') notes.push('this build carries no build-info.json, so the commit below is read from the checkout it sits in rather than recorded by the build -- a `npm run build` in this repository stamps it');
  if (facts.dirty === true) notes.push('the checkout had uncommitted changes when this was recorded, so the commit below may not be what actually ran');

  const baseCommit = root && base ? git(root, ['rev-parse', base]) : '';
  if (!base && root) notes.push('no base ref was asked for, so how far behind one this build is was not measured');
  else if (!baseCommit) notes.push(`${base} does not resolve here, so how far behind it is could not be measured`);
  // The subject of the comparison is the BUILD's commit, not the checkout's HEAD, and the difference is
  // the point of the whole module. They diverge the moment anyone pulls, switches branches, or commits
  // into the directory a deployed dist sits in -- which is ordinary, because that is what a checkout is
  // for. Comparing HEAD would then report a dist built two commits ago as current, having silently
  // answered a different question than the one being asked. With no stamp there is nothing else to
  // compare, so it falls back to HEAD and says so in `notes`.
  const subject = String(facts.commit ?? '') || 'HEAD';
  if (source === 'stamp' && subject !== 'HEAD' && git(root, ['rev-parse', 'HEAD']) !== subject) {
    notes.push(`this checkout has moved since the build (HEAD is ${(git(root, ['rev-parse', '--short', 'HEAD']) || '?').slice(0, 7)}, the build is ${subject.slice(0, 7)}), so the comparison below is against the build's own commit`);
  }
  // `rev-list --left-right --count A...B` prints A-only first, then B-only. Measured on a scratch
  // repo with a deliberately diverged ref rather than assumed: A-only is `ahead`, B-only is `behind`.
  // Getting these the wrong way round turns a stale deploy into a clean bill.
  const counts = baseCommit ? git(root, ['rev-list', '--left-right', '--count', `${subject}...${base}`]).split(/\s+/).map(Number) : [];
  const ahead = counts.length === 2 && counts.every(Number.isFinite) ? counts[0] : null;
  const behind = counts.length === 2 && counts.every(Number.isFinite) ? counts[1] : null;

  const builtAt = entry ? mtime(entry) : '';
  const newestSourceAt = root ? newestSource(root) : '';
  if (!builtAt) notes.push('there is no dist/index.js here, so this is a source tree rather than a built server');

  return {
    version,
    commit: String(facts.commit ?? ''),
    describe: String(facts.describe ?? ''),
    branch: String(facts.branch ?? ''),
    dirty: typeof facts.dirty === 'boolean' ? facts.dirty : null,
    source,
    built_at: builtAt,
    newest_source_at: newestSourceAt,
    base,
    base_commit: baseCommit,
    behind,
    ahead,
    // Null, not false: "could not measure" is not "current". The whole point of this module is that
    // an unmeasured build must not read as a verified one.
    stale: behind === null ? null : behind > 0,
    notes,
  };
};

/**
 * Whether a build is fit to be deployed, and why not when it is not.
 *
 * Kept separate from `buildInfo` so the decision is a pure function of stated facts: the git calls
 * happen once, here, and every rule below is a rule about numbers a test can write down.
 */
export const deployVerdict = (info: BuildInfo): { ok: boolean; reasons: string[] } => {
  const reasons: string[] = [];
  if (info.source === 'none') reasons.push('the build records no commit, so there is nothing to compare against a base ref');
  if (info.behind !== null && info.behind > 0) {
    reasons.push(`built ${info.behind} commit${info.behind === 1 ? '' : 's'} behind ${info.base} (${info.base_commit.slice(0, 7)}); ${info.commit.slice(0, 7)} is what is running`);
  }
  if (info.behind === null) reasons.push(`how far behind ${info.base} this build is could not be measured, so it is unverified rather than current`);
  if (info.dirty === true) reasons.push('the tree had uncommitted changes when this was built');
  if (!info.built_at) reasons.push('there is no dist/ here to serve');
  else if (info.newest_source_at && info.newest_source_at > info.built_at) {
    reasons.push(`a source file is newer than dist/index.js (${info.newest_source_at} against ${info.built_at}), so the build predates the code beside it`);
  }
  return { ok: reasons.length === 0, reasons };
};

/**
 * Whether the `dist/` in this checkout is the build of the tree sitting beside it -- the question a
 * process start can actually answer, and a different one from `deployVerdict`.
 *
 * `deployVerdict` asks whether the build is current with a base ref, which needs the network: it is
 * the right question before trusting a deployment, and the wrong one to put in front of every server
 * start, because "how far behind main are we" is fixed by a pull and no amount of rebuilding can fix
 * it. This asks the question a rebuild *can* fix: do the bytes in `dist/` correspond to the sources
 * next to them. It is local -- one `git rev-parse`, a stat, a walk of `src/` -- so it costs a few
 * milliseconds rather than a round trip, which is what lets `scripts/serve.mjs` run it on every
 * spawn.
 *
 * `head` is the checkout's HEAD, passed in rather than read here, so this stays a pure function of
 * stated facts exactly as `deployVerdict` is. `''` means this is not a git checkout at all -- an
 * installed tarball -- and there is nothing to compare, so the commit rules are skipped rather than
 * failed. Failing them would make the launcher refuse to serve the one case where it has no work to do.
 *
 * `info.dirty` is deliberately not a rule, and that is the part worth arguing about. Uncommitted
 * sources do not make a `dist/` stale: once it has been built, the build *is* the tree, dirt and all,
 * and `deployVerdict` reads dirtiness off the stamp, which a rebuild of a dirty tree sets again --
 * keying freshness on it would rebuild on every single start, forever, and each rebuild would stamp
 * itself dirty and trigger the next one. Freshness and provenance are different questions. What dirt
 * costs is the ability to name the build as a clean commit, and that is `capabilities`' business, not
 * this one's. A dirty tree whose sources are newer than its `dist/` is still caught below, by mtime.
 *
 * `now` exists so the mtime comparison has a ceiling, and so this stays a function of stated facts
 * rather than of a clock nobody controls.
 */
export const serveVerdict = (info: BuildInfo, head: string, now = new Date().toISOString()): { ok: boolean; reasons: string[] } => {
  const reasons: string[] = [];
  // `now` bounds the mtime comparison, and it is a deliberate decision not to act, so it is worth
  // stating. A source whose mtime is later than the moment this check ran is a clock disagreeing with
  // ours, not an edit made after the build -- and believing it would rebuild on every spawn forever,
  // because each rebuild lands at "now", which is still older than the file. Skew is real (a mounted
  // checkout, a machine whose clock is minutes out) and the cost of getting this wrong is an `npm ci`
  // per session for as long as the skew lasts. Nothing is hidden by ignoring it: `npm run check:deploy`
  // prints the mtimes verbatim, so the absurd date is right there for whoever looks.
  const predates = Boolean(info.newest_source_at) && info.newest_source_at! > info.built_at && info.newest_source_at! <= now;
  if (!info.built_at) reasons.push('there is no dist/index.js here to serve');
  else if (predates) {
    reasons.push(`a source file is newer than dist/index.js (${info.newest_source_at} against ${info.built_at}), so the build predates the code beside it`);
  }
  if (head) {
    // The order of these two matters only for which sentence a person reads first, but the second
    // cannot be stated without the first: without a stamp there is no commit to compare to HEAD, and
    // naming that as "unstamped" is the honest version of what is otherwise a confusing "built from ".
    if (info.source !== 'stamp') reasons.push('this dist/ carries no build-info.json, so it cannot be shown to be the build of this checkout');
    else if (info.commit !== head) reasons.push(`this dist/ was built from ${info.commit.slice(0, 7)} and this checkout is at ${head.slice(0, 7)}`);
  }
  return { ok: reasons.length === 0, reasons };
};
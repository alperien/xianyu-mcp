/** Reports the running build's stamp and its distance from a base ref.
 *
 * `stampBuild` writes `dist/build-info.json` during `npm run build`. Reading that stamp keeps the
 * reported commit tied to the deployed files even if the checkout later moves. Without a stamp, the
 * report falls back to the enclosing git checkout and notes the fallback.
 *
 * Comparisons use the local remote-tracking ref, which may be stale. Callers that need a current
 * comparison must fetch first; `scripts/check-deploy.mjs` does this. This module does not throw, since
 * `capabilities` must still return a result when git, `dist/`, or part of the checkout is unavailable.
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
  /** ISO 8601. When the build ran, which is not when the sources last changed. */
  built_at?: string;
}

export interface BuildInfo {
  /** package.json's version, or '' if it could not be read. Never a literal, for the reason index.ts documents. */
  version: string;
  /** The full commit this build came from, or '' when nothing recorded one. */
  commit: string;
  /** `git describe` at stamp time, e.g. `v0.1.0-10-g8ff22ce`: a release name and the distance from it in one string. */
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
  /** Commits on base but not on this build. `null` when unknown, which is not zero. */
  behind: number | null;
  /** Commits on this build but not on base. A local build ahead of main is normal mid-work and is not drift. */
  ahead: number | null;
  /** True when this build is known to be older than base. The headline number. */
  stale: boolean | null;
  /** Anything that made the answer partial, in plain words. Empty means the answer is complete. */
  notes: string[];
}

const GIT_TIMEOUT_MS = 5000;

/** Run git and return stdout, or '' on any failure: no git, a directory that is not a checkout, a
 *  lock held by a concurrent fetch. All of them mean no answer, never an exception. */
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

/** Find this package's root from either `src/`, `dist/`, or an installed tarball. */
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

/** Ask the enclosing checkout what it is. No stamp means the pre-stamp build or a tarball's
 *  deployed checkout, and either way the answer reports `git`, not `stamp`. */
const fromGit = (root: string): BuildStamp => ({
  commit: git(root, ['rev-parse', 'HEAD']),
  describe: git(root, ['describe', '--tags', '--always', '--dirty']),
  branch: git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
  dirty: git(root, ['status', '--porcelain']) ? true : undefined,
});

/** Describe the build at `root` and, when requested, compare it with `base`.
 *
 * By default, `base` is the local `origin/main` ref; callers needing a current result should fetch it
 * first. An empty `base` skips comparison and reports `behind: null`, not zero. */
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
    // The comparison is against the BUILD's commit, not the checkout's HEAD: they diverge the moment
    // anyone pulls, switches branches, or commits into the directory a deployed dist sits in. Comparing
    // HEAD would report a dist built two commits ago as current, having answered a different question.
    // With no stamp it falls back to HEAD and says so in `notes`.
  const subject = String(facts.commit ?? '') || 'HEAD';
  if (source === 'stamp' && subject !== 'HEAD' && git(root, ['rev-parse', 'HEAD']) !== subject) {
    notes.push(`this checkout has moved since the build (HEAD is ${(git(root, ['rev-parse', '--short', 'HEAD']) || '?').slice(0, 7)}, the build is ${subject.slice(0, 7)}), so the comparison below is against the build's own commit`);
  }
  // `rev-list --left-right --count A...B` prints A-only first, then B-only. Measured on a scratch repo
  // with a deliberately diverged ref rather than assumed: A-only is `ahead`, B-only is `behind`.
  // Swapped, a stale deploy reads as a clean bill.
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
    // Null, not false: "could not measure" is not "current".
    stale: behind === null ? null : behind > 0,
    notes,
  };
};

/**
 * Whether a build is fit to be deployed, and why not when it is not.
 *
 * Separate from `buildInfo` so the decision is a pure function of stated facts: the git calls happen
 * once, in buildInfo, and every rule below is a rule about numbers a test can write down.
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

/** Check whether `dist/` matches the sources beside it. Unlike `deployVerdict`, this is a local
 * check suitable for every server start. `head` is passed in to keep the result a function of stated
 * facts; an empty value means there is no checkout to compare (for example, an installed tarball).
 * Dirty state alone does not make a build stale, but a source newer than the build does. `now` bounds
 * the mtime check and makes clock skew explicit. */
export const serveVerdict = (info: BuildInfo, head: string, now = new Date().toISOString()): { ok: boolean; reasons: string[] } => {
  const reasons: string[] = [];
  // Ignore source mtimes later than `now`; they indicate clock skew, not a post-build edit.
  const predates = Boolean(info.newest_source_at) && info.newest_source_at! > info.built_at && info.newest_source_at! <= now;
  if (!info.built_at) reasons.push('there is no dist/index.js here to serve');
  else if (predates) {
    reasons.push(`a source file is newer than dist/index.js (${info.newest_source_at} against ${info.built_at}), so the build predates the code beside it`);
  }
  if (head) {
    // Without a stamp, there is no build commit to compare with HEAD.
    if (info.source !== 'stamp') reasons.push('this dist/ carries no build-info.json, so it cannot be shown to be the build of this checkout');
    else if (info.commit !== head) reasons.push(`this dist/ was built from ${info.commit.slice(0, 7)} and this checkout is at ${head.slice(0, 7)}`);
  }
  return { ok: reasons.length === 0, reasons };
};
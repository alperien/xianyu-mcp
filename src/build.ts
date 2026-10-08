/**
 * The deployed build, reported by the server itself.
 *
 * `capabilities` is documented as the call to make before anything else, so it is the one place a
 * stale deployment can announce itself to every agent in the town without anyone running a check. The
 * MCP handshake already carries a version; this adds the commit, because a version alone did not
 * catch a deploy nine commits and a whole release behind -- 0.2.0 was in package.json, so the version
 * looked right while the code was not.
 */
import { buildInfo, deployVerdict } from './build-info.ts';

/** The build block, shaped for a caller rather than for a test: what is running, and is it current. */
export const buildBlock = (root?: string) => {
  const info = buildInfo(root);
  const { ok, reasons } = deployVerdict(info);
  return {
    version: info.version,
    commit: info.commit || '(unrecorded)',
    describe: info.describe || '(unrecorded)',
    branch: info.branch || '(unknown)',
    dirty: info.dirty,
    /** Which of the two sources the answer came from; `stamp` is the honest build, `git` is a fallback. */
    provenance: info.source,
    built_at: info.built_at || '(no dist/)',
    compared_against: info.base,
    base_commit: info.base_commit || '(unresolved)',
    ahead: info.ahead,
    behind: info.behind,
    /** True, false, or null for "could not be measured" -- which is deliberately not the same as false. */
    stale: info.stale,
    deployable: ok,
    // Empty when there is nothing to say. Every entry is a fact a caller would otherwise have to go
    // and measure itself, which is how the original nine-commit drift stayed invisible for nine
    // commits with nothing in any answer saying so.
    reasons,
  };
};
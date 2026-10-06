/**
 * The rewrite script's only job is to change a subject line and change nothing else. That is a claim
 * about git plumbing, and a claim about plumbing is worth testing rather than trusting, so these
 * build a throwaway repository with the same shape as the real one -- a commit the safety net wrote
 * with an empty body, sandwiched between commits a person wrote -- and check that after the rewrite
 * every tree is the same object, every author and committer line is byte-identical, and every commit
 * nobody asked to edit hashes back to itself.
 *
 * The last one is the strongest of the checks. A commit's sha is a hash of its content, so a commit
 * that comes back with its own sha cannot have been touched in any byte, and a chain where that holds
 * for everything below the first edit is proof the rewrite started where it meant to.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCommits, parseCommit, planRewrite, retitle, rewrite } from '../scripts/humanize-history.mjs';

/**
 * Four commits with four different identities and four different dates, so a rewrite that collapsed
 * them onto one value would be caught by an equality check rather than by eyeballing the log.
 */
function run(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'a',
      GIT_AUTHOR_EMAIL: 'a@example.invalid',
      GIT_COMMITTER_NAME: 'a',
      GIT_COMMITTER_EMAIL: 'a@example.invalid',
    },
  });
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'humanize-history-'));
  const run = (args, env = {}) =>
    execFileSync('git', ['-C', dir, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'a',
        GIT_AUTHOR_EMAIL: 'a@example.invalid',
        GIT_COMMITTER_NAME: 'a',
        GIT_COMMITTER_EMAIL: 'a@example.invalid',
        ...env,
      },
    });
  run(['init', '-q', '-b', 'main']);
  const at = (minute) => ({
    GIT_AUTHOR_DATE: `17000000${minute} +0000`,
    GIT_COMMITTER_DATE: `17000050${minute} +0000`,
  });
  const commit = (file, body, who, minute) => {
    writeFileSync(join(dir, file), `${file} at ${minute}\n`);
    run(['add', file]);
    run(['commit', '-q', '-m', body], {
      GIT_AUTHOR_NAME: who,
      GIT_AUTHOR_EMAIL: `${who}@example.invalid`,
      GIT_COMMITTER_NAME: who,
      GIT_COMMITTER_EMAIL: `${who}@example.invalid`,
      ...at(minute),
    });
  };
  commit('a.txt', 'docs: CI badge, corrected test count, and the Python lineage', 'mayor', '01');
  // The shape of the real thing: subject only, nothing under it.
  commit('probe.mjs', 'WIP: checkpoint (auto)', 'user', '02');
  commit('b.txt', 'feat: every listing gains a typed block beside its strings\n\nthe body, which has\na second line and no trailing newline of its own', 'capable', '03');
  commit('c.txt', 'perf: the measurements, the corrected numbers, and the probes that took them', 'dementus', '04');
  return dir;
}

const headers = (repo, sha, key) =>
  parseCommit(execFileSync('git', ['-C', repo, 'cat-file', 'commit', sha]))
    .headers.filter((l) => l.startsWith(`${key} `))
    .join('\n');

const parents = (repo, sha) =>
  parseCommit(execFileSync('git', ['-C', repo, 'cat-file', 'commit', sha]))
    .headers.filter((l) => l.startsWith('parent '))
    .map((l) => l.slice(7));

test('a retitle changes the subject and nothing else in the commit', () => {
  const message = Buffer.from('the old subject\n\nfirst paragraph\n\nsecond paragraph\n', 'utf8');
  assert.equal(
    retitle(message, 'the new subject').toString('utf8'),
    'the new subject\n\nfirst paragraph\n\nsecond paragraph\n',
  );
  // A subject-only message must not grow a body out of the rewrite.
  assert.equal(retitle(Buffer.from('WIP: checkpoint (auto)\n'), 'probe: a guard').toString('utf8'), 'probe: a guard\n');
});

test('the rewrite re-parents the chain and leaves every tree, date and identity alone', () => {
  const repo = makeRepo();
  try {
    const before = loadCommits(repo, 'main');
    assert.equal(before.length, 4);
    const target = before[1];
    assert.equal(target.subject, 'WIP: checkpoint (auto)');

    const plan = planRewrite(before, new Map([[target.sha, { old: target.subject, new: 'probe: a guard that survives a wedged page' }]]));
    // The base is the parent of the first edited commit, which is what makes the commits below it
    // provably untouched rather than merely unchanged-looking.
    assert.equal(plan.base, before[0].sha);
    assert.deepEqual(plan.rows.map((r) => r.action), ['keep', 'retitle', 'keep', 'keep']);

    const result = rewrite(repo, plan);
    const after = result.checked;

    // Nothing at or below the base is rebuilt, so checked starts at the commit that was edited.
    assert.equal(after[0].from, before[1].sha);
    assert.equal(after.length, before.length - 1);
    for (let i = 0; i < after.length; i += 1) {
      const was = before[i + 1];
      const now = after[i].to;
      assert.notEqual(now, was.sha, `${was.sha} is at or above the edit, so its sha moves`);
      assert.equal(parseCommit(execFileSync('git', ['-C', repo, 'cat-file', 'commit', now])).tree, was.tree);
      for (const key of ['author', 'committer']) {
        assert.equal(headers(repo, now, key), headers(repo, was.sha, key));
      }
    }
    assert.equal(result.tip, after.at(-1).to);
    // The chain has to actually be a chain. A rebuild that left the old parent in place and
    // appended the new one as a second line would produce plausible-looking commits that still hang
    // off the history they were supposed to replace, and every other assertion would still pass.
    assert.equal(parents(repo, after[0].to).length, 1, 'one parent, not one plus another');
    for (let i = 0; i < after.length; i += 1) {
      assert.deepEqual(parents(repo, after[i].to), [i === 0 ? before[0].sha : after[i - 1].to]);
    }
    assert.equal(
      parseCommit(execFileSync('git', ['-C', repo, 'cat-file', 'commit', result.tip])).tree,
      before.at(-1).tree,
      'the rewritten tip must be the same tree the old tip was',
    );
    assert.match(execFileSync('git', ['-C', repo, 'log', '-1', '--format=%B', result.tip]).toString(), /^perf: the measurements/);

    // And the working tree still builds what the old history built.
    execFileSync('git', ['-C', repo, 'checkout', '-q', result.tip]);
    assert.equal(execFileSync('git', ['-C', repo, 'status', '--porcelain']).toString(), '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a subject the mapping does not match is drift, and overwriting it would be wrong', () => {
  const repo = makeRepo();
  try {
    const [head] = loadCommits(repo, 'main');
    assert.throws(
      () => planRewrite(loadCommits(repo, 'main'), new Map([[head.sha, { old: 'WIP: checkpoint (auto)', new: 'probe: whatever' }]])),
      /subject drift/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a merge in the range is refused rather than flattened', () => {
  const repo = makeRepo();
  try {
    run(repo, ['checkout', '-q', '-b', 'side', 'main~2']);
    writeFileSync(join(repo, 'side.txt'), 'side\n');
    run(repo, ['add', 'side.txt']);
    run(repo, ['commit', '-q', '-m', 'feat: a commit only the side branch has']);
    run(repo, ['checkout', '-q', 'main']);
    run(repo, ['merge', '-q', '--no-ff', '-m', 'feat: a merge', 'side']);
    assert.throws(() => loadCommits(repo, 'main'), /is a merge with 2 parents/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a range with nothing mapped writes no object and leaves the tip where it was', () => {
  const repo = makeRepo();
  try {
    const before = loadCommits(repo, 'main');
    const plan = planRewrite(before, new Map());
    assert.equal(plan.base, null);
    const result = rewrite(repo, plan);
    assert.deepEqual(result.checked, []);
    assert.equal(result.tip, before.at(-1).sha);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
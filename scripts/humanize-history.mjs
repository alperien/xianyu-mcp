/**
 * Retitle the commits gt's auto-save safety net wrote, and nothing else.
 *
 * Between 2026-10-03 and 2026-10-04 this repo picked up four commits whose subject is exactly
 * "WIP: checkpoint (auto)", whose body is not a single word, and which are authored by the ambient
 * "user <user@localhost>" rather than by the polecat whose work they carry. All four were written
 * to the object store in a four-second burst at 12:43:12-12:43:13 on 2026-10-04, while their author
 * dates say 17:08, 17:15, 17:26 and 06:27 the next morning: that is one machine rewriting four
 * commits it had made hours apart. Every other commit in the history has a polecat's name, a
 * mechanism-naming subject, and a body that argues for the change. The contrast is what makes these
 * four an artifact of the harness rather than a record of work.
 *
 * This script edits subjects. It does not squash, drop, reorder, reword, re-date or re-author
 * anything, and it never pushes. A rewrite of commit messages still changes every sha above the
 * first edit, so this is a decision the maintainer takes, not one a tool takes on its own.
 *
 * The rewrite goes through `git hash-object -t commit` rather than `git commit-tree` or
 * `git filter-branch` on purpose. Those two rebuild the header from parsed fields, and either can
 * tidy the message or normalize a date on the way through. Reading the raw commit object, replacing
 * the `parent` lines and, for the mapped commits, the first line of the message, and hashing that
 * back means the author line, the committer line, the encoding header and every message byte outside
 * the subject survive exactly as they were. Three of the four histories in this repo have commits
 * that were rebased on the way in; their committer dates are evidence of when work actually landed,
 * and a humanizer that reset them would be lying about the record it claims to be preserving.
 *
 * Usage:
 *   node scripts/humanize-history.mjs                     # dry run, the default
 *   node scripts/humanize-history.mjs --to main           # read main instead of origin/main
 *   node scripts/humanize-history.mjs --range <rev>       # rewrite an explicit range
 *   node scripts/humanize-history.mjs --apply              # write the result to a NEW ref
 *
 * `--apply` writes refs/heads/humanized/<tip> and stops. It moves no existing branch, touches no
 * tag, and runs no network command. Moving main onto the result is a separate, deliberate act:
 *
 *   git update-ref refs/heads/main refs/heads/humanized/main
 *   git push --force-with-lease origin main
 *   git tag -a v0.1.0 -m "v0.1.0" refs/heads/main          # the old tag now points at an orphan
 *
 * Run it with no arguments first. The dry run prints every subject before and after, the base commit
 * whose sha will not move, and every tag the rewrite orphans.
 */
import { execFileSync } from 'node:child_process';

export const RETITLE = new Map([
  [
    '962182644c820353245d31a78657c005a51bb206',
    {
      old: 'WIP: checkpoint (auto)',
      // Three scripts, one response listener each. probe.mjs takes any URL on argv and prints the
      // first reply per mtop api; probe2.mjs goes to a fixed item id and asks which id field the
      // detail payload carries (sellerDO, itemDO); probe3.mjs goes to a fixed userId and asks the
      // same of page.head.
      new: 'probe: three measurement scripts -- mtop taps on any URL, the detail seller\'s ids, and the user page\'s baseInfo',
    },
  ],
  [
    '1d45c5d8f13a037da1c1d43d1d72f9525713b441',
    {
      old: 'WIP: checkpoint (auto)',
      // The first two guards: every navigation, wait and evaluate is wrapped so a page that never
      // settles still prints what it did see, and the scripts exit 0 instead of hanging the session.
      // probe4.mjs is the new thing: the homepage's category links, because a search-by-category is
      // the obvious entry point nobody had measured.
      new: 'probe: a wedged page must still report, so every navigation is guarded -- plus the homepage\'s category links',
    },
  ],
  [
    'cdd06772bbda27d3cd8bdda799ceb2e48d3dd967',
    {
      old: 'WIP: checkpoint (auto)',
      // Same guards carried into probe.mjs, and probe5.mjs walks two entry points back to back --
      // the machined feed and a keyword search with a category pinned -- printing each one's mtop
      // taps and the first 160 characters of rendered body, because the two disagree about what the
      // page is doing.
      new: 'probe: the feed and search entry points, each printed with its mtop taps and the first 160 characters of body',
    },
  ],
  [
    '7649fee3f961963bbdfd2ec89b8d6a28de10c396',
    {
      old: 'WIP: checkpoint (auto)',
      // probe6.mjs stops listening on the network and calls window.lib.mtop.request inside the page,
      // which is the only way to see what the site itself asks for. Three calls: page.head with the
      // userId, page.head with nothing, and the search hit counter.
      new: 'probe: lib.mtop.request called inside the page -- page.head with and without a userId, and the search hit counter',
    },
  ],
  [
    '4acf626e8dce8b7bcb39701ea0511388410bf8b4',
    {
      old: 'WIP: TTL cache for item detail and search pages, staleness published (xi-byi)',
      // Hand-written, not machine-written: capable's name, a body that argues for the design, and a
      // committer date 14 minutes after the author date. But it is the commit that ships src/cache.ts
      // and test/cache.test.ts, and it opens with WIP. The body's own "WIP: not re-verified end to
      // end" stays -- that disclosure is the point of the commit, not a prefix.
      new: 'feat: a TTL cache on item detail and search pages, and every hit publishes its own age (xi-byi)',
    },
  ],
  [
    'c5543851ced44d256188c1b6d3d06afb905c1974',
    {
      old: 'WIP(mid-task xi-cln): capabilities freshness answer no longer waits for a browser launch',
      // Same safety net, a different spelling, on the capability branch rather than on origin/main.
      // Not cruft: 642ccee adds only README.md and CHANGELOG.md on top of it, so this commit carries
      // the src/tools.ts and test changes that the next commit then documents.
      new: 'capabilities: probe defaults true, and probe:false returns build, cache and payload without getSession() (xi-cln)',
    },
  ],
]);

const git = (repo, args, input) =>
  execFileSync('git', ['-C', repo, ...args], input === undefined ? undefined : { input });

/** Raw commit object, split into header fields and the message bytes after the first blank line. */
export function parseCommit(raw) {
  const sep = raw.indexOf('\n\n');
  const headerText = raw.toString('utf8', 0, sep === -1 ? raw.length : sep);
  const message = sep === -1 ? Buffer.alloc(0) : raw.subarray(sep + 2);
  const headers = [];
  // Where the parent lines start and how many there are, so a rebuild can swap them without
  // touching the tree, the author, the committer or an encoding/gpgsig header. `parentStart` is the
  // index in `headers` -- headers are pushed in the same pass, so the index is the length so far.
  let parentStart = -1;
  let parentCount = 0;
  let inParents = false;
  for (const line of headerText.split('\n')) {
    if (line.startsWith('parent ')) {
      if (!inParents) {
        parentStart = headers.length;
        inParents = true;
      }
      parentCount += 1;
    } else if (inParents && /^\s/.test(line)) {
      // A folded continuation belongs to the header above it, so it moves with the parent block.
      parentCount += 1;
    } else {
      inParents = false;
    }
    headers.push(line);
  }
  const tree = headers.find((l) => l.startsWith('tree '))?.slice(5);
  const signed = headers.some((l) => l.startsWith('gpgsig ') || l.startsWith('gpgsig-sha256 '));
  return { headers, parentStart, parentCount, tree, signed, message };
}

/** The message with its first line replaced. Everything after the subject is returned untouched. */
export function retitle(message, subject) {
  const newline = message.indexOf(0x0a);
  const tail = newline === -1 ? Buffer.alloc(0) : message.subarray(newline + 1);
  return Buffer.concat([Buffer.from(`${subject}\n`, 'utf8'), tail]);
}

/**
 * Oldest first, one row per commit, each carrying the parsed object so the rebuild never has to
 * re-read it.
 *
 * `--first-parent` makes the list linear, but a merge commit in the range is still a commit with two
 * parent lines, and this rewrite replaces the parent block with a single one -- which would flatten
 * the merge and take the second parent out of the history without saying so. So a merge is refused
 * rather than silently linearized. Rewriting across a merge needs a decision about what the other
 * parent should become, and that is not a decision to infer from the sha count.
 */
export function loadCommits(repo, tip) {
  const shas = git(repo, ['rev-list', '--first-parent', '--reverse', tip])
    .toString('utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
  return shas.map((sha) => {
    const c = parseCommit(git(repo, ['cat-file', 'commit', sha]));
    const parents = c.headers.filter((l) => l.startsWith('parent ')).map((l) => l.slice(7));
    if (parents.length > 1) {
      throw new Error(`refusing: ${sha.slice(0, 7)} is a merge with ${parents.length} parents`);
    }
    return {
      sha,
      tree: c.tree,
      parents,
      signed: c.signed,
      subject: c.message.toString('utf8').split('\n')[0],
      raw: c,
    };
  });
}

/**
 * Which commits get a new subject, and what the rewrite would leave alone. An entry whose recorded
 * `old` does not match the commit in the repo is drift -- someone edited that subject by hand since
 * the mapping was written -- and aborts rather than overwriting their wording.
 */
export function planRewrite(commits, retitle_) {
  const present = new Map(commits.map((c) => [c.sha, c]));
  const rows = commits.map((c) => {
    const rule = retitle_.get(c.sha);
    if (!rule) return { ...c, next: c.subject, action: 'keep' };
    if (rule.old !== c.subject) {
      throw new Error(
        `subject drift at ${c.sha.slice(0, 7)}\n  expected: ${rule.old}\n  in repo:   ${c.subject}`,
      );
    }
    return { ...c, next: rule.new, action: 'retitle' };
  });
  const absent = [...retitle_.keys()].filter((sha) => !present.has(sha));
  return { rows, absent, base: rows.find((r) => r.action === 'retitle')?.parents[0] ?? null };
}

function writeCommit(repo, { headers, parentStart, parentCount }, message, parents) {
  const out = [...headers];
  if (parentCount === 0) {
    for (const p of parents) out.push(`parent ${p}`);
  } else {
    out.splice(parentStart, parentCount, ...parents.map((p) => `parent ${p}`));
  }
  const rebuilt = Buffer.concat([
    Buffer.from(`${out.join('\n')}\n\n`, 'utf8'),
    message,
  ]);
  return git(repo, ['hash-object', '-t', 'commit', '-w', '--stdin'], rebuilt)
    .toString('utf8')
    .trim();
}

/**
 * Rebuild the chain from `base` to `tip` with the planned subjects, verifying after every commit
 * that the tree is the same object and that the author and committer headers are byte-identical.
 * A commit whose sha is unchanged is proof the edit did nothing; a run where the top of the chain
 * matches by accident is not proof at all, so the assertions are about content, not shas.
 */
export function rewrite(repo, plan) {
  const rows = plan.rows;
  // The base is the parent of the first edited commit, and nothing at or below it is rebuilt. That
  // is what keeps the rewrite surgical: every sha under the base is unchanged because the object
  // was never read back in.
  const start = plan.base ? rows.findIndex((r) => r.sha === plan.base) : -1;
  const editable = start === -1 ? [] : rows.slice(start + 1);
  const oldTip = rows.at(-1)?.sha ?? null;
  if (!editable.length) return { tip: oldTip, checked: [] };
  const signed = editable.filter((r) => r.signed);
  if (signed.length) {
    throw new Error(
      `refusing: ${signed.map((r) => r.sha.slice(0, 7)).join(', ')} carry a signature that a reword would invalidate`,
    );
  }
  let parent = plan.base;
  const checked = [];
  for (const row of editable) {
    const message =
      row.action === 'retitle'
        ? retitle(row.raw.message, row.next)
        : row.raw.message;
    const parents = parent ? [parent] : row.parents;
    const sha = writeCommit(repo, row.raw, message, parents);
    const after = parseCommit(git(repo, ['cat-file', 'commit', sha]));
    if (after.tree !== row.tree) throw new Error(`tree changed at ${row.sha.slice(0, 7)}`);
    const newParents = after.headers.filter((l) => l.startsWith('parent ')).map((l) => l.slice(7));
    if (newParents.length !== parents.length || !newParents.every((p, i) => p === parents[i])) {
      // The failure this catches is silent and expensive: a rebuilt commit that kept its old parent
      // and gained the new one as a second line still hashes, still shows the expected tree and the
      // expected message, and still has a plausible subject -- and the rewrite does nothing.
      throw new Error(`parent of ${row.sha.slice(0, 7)} is not the one the rewrite asked for`);
    }
    for (const key of ['author', 'committer']) {
      const was = row.raw.headers.filter((l) => l.startsWith(`${key} `)).join('\n');
      const now = after.headers.filter((l) => l.startsWith(`${key} `)).join('\n');
      if (was !== now) throw new Error(`${key} changed at ${row.sha.slice(0, 7)}`);
    }
    if (row.action === 'keep') {
      if (!after.message.equals(row.raw.message)) {
        throw new Error(`message changed at ${row.sha.slice(0, 7)} on a commit nobody asked to edit`);
      }
      // A commit whose parents came out unchanged must hash back to itself. Anything else means the
      // rebuild altered a byte it was supposed to copy, and a sha collision cannot explain it.
      if (parents.length === row.parents.length && parents.every((p, i) => p === row.parents[i]) && sha !== row.sha) {
        throw new Error(`${row.sha.slice(0, 7)} had unchanged parents but did not hash to itself`);
      }
    }
    checked.push({ from: row.sha, to: sha, subject: row.next, action: row.action });
    parent = sha;
  }
  return { tip: parent, checked };
}

/** Tags that point into the rewritten range, and therefore at objects the rewrite replaces. */
export function orphanedTags(repo, plan) {
  const moved = new Set(plan.rows.map((r) => r.sha));
  const out = [];
  for (const line of git(repo, ['for-each-ref', '--format=%(refname) %(objectname) %(*objectname)', 'refs/tags'])
    .toString('utf8')
    .trim()
    .split('\n')) {
    if (!line) continue;
    const [ref, obj, peeled] = line.split(' ');
    if (moved.has(obj) || (peeled && moved.has(peeled))) out.push({ ref, obj, peeled });
  }
  return out;
}

function main(argv) {
  const apply = argv.includes('--apply');
  const repo = process.cwd();
  const value = (flag) => {
    const i = argv.indexOf(flag);
    if (i === -1) return null;
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${flag} needs a revision`);
    return v;
  };
  const tip = value('--range') ?? value('--to') ?? 'origin/main';

  const plan = planRewrite(loadCommits(repo, tip), RETITLE);
  const changed = plan.rows.filter((r) => r.action === 'retitle');

  console.log(`range ${tip}: ${plan.rows.length} commits`);
  if (!changed.length) console.log('nothing to retitle in this range');
  for (const sha of plan.absent) {
    console.log(`  not in range: ${sha.slice(0, 7)} (${RETITLE.get(sha).old})`);
  }
  console.log();
  for (const row of plan.rows) {
    const tag = row.action === 'retitle' ? '->' : '  ';
    console.log(`${row.sha.slice(0, 7)} ${tag} ${row.subject}`);
    if (row.action === 'retitle') console.log(`         ${tag} ${row.next}`);
  }
  console.log();

  const base = plan.base
    ? `${plan.base.slice(0, 7)} stays at ${plan.base.slice(0, 7)} -- everything below it keeps its sha`
    : 'no retitle in range: nothing below it moves either';
  const baseIndex = plan.base ? plan.rows.findIndex((r) => r.sha === plan.base) : -1;
  const moved = baseIndex === -1 ? 0 : plan.rows.length - baseIndex - 1;
  console.log(`base: ${base}`);
  console.log(`sha changes for ${moved} of ${plan.rows.length} commits: the retitled one and everything above it`);

  const tags = orphanedTags(repo, plan);
  for (const t of tags) {
    console.log(`tag ${t.ref} -> ${(t.peeled || t.obj).slice(0, 7)} is inside the rewritten range and would dangle`);
  }
  if (!tags.length) console.log('no tag points into the rewritten range');

  if (!apply) {
    console.log('\ndry run: no object written, no ref moved. Re-run with --apply to write the result.');
    return 0;
  }
  if (!changed.length) {
    console.log('\nnothing to do.');
    return 0;
  }
  const result = rewrite(repo, plan);
  const ref = `refs/heads/humanized/${tip.replace(/[^A-Za-z0-9._-]/g, '_')}`;
  git(repo, ['update-ref', ref, result.tip]);
  const rewritten = result.checked.filter((c) => c.from !== c.to).length;
  console.log(`\nwrote ${ref} -> ${result.tip.slice(0, 7)} (${rewritten} shas changed)`);
  console.log('verify with: git log --oneline ' + result.tip);
  console.log('this moved no branch, no tag and no remote. main is still where it was.');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(1);
  }
}
# git history: which commits the machine wrote, and the five that should say what they did

This is the answer to one request -- "git history must be humanized as well" -- and it is mostly a
refusal. Of the twenty-four commits on `origin/main`, five carry a subject the harness wrote for
them. The other nineteen are a maintainer's own work, and running a humanizer over those nineteen
would be the damage, not the cure. Below is the case for each of them, the case for each of the five,
and a script that makes the five edits and refuses to make the others.

Nothing in this repo's history has been rewritten yet. The script is here; the decision is not mine.

## What "machine-written" means here, from this repo's own evidence

Three tells, and they only count together:

1. **A subject with no mechanism in it.** `WIP: checkpoint (auto)` names no file, no symbol, no
   behaviour, and no reason. It is a label applied to whatever was in the working tree at the moment
   something ran.
2. **No body at all.** Not a short body: zero bytes. Nineteen of the twenty-four commits here argue
   something under the subject; four of the five machine ones say nothing.
3. **An author that is not a worker.** These four are authored by `user <user@localhost>`, the
   ambient git identity, not by `mayor`, `capable`, `dementus`, `rictus`, `slit`, `furiosa` or
   `toast`. Every other commit in the history is under a named agent.

And the fourth tell, which is only visible in the metadata and settles it: all four were written to
the object store in a four-second window.

```
9621826  author 2026-10-03 17:08:22 +0500   committer 2026-10-04 12:43:12 +0500
1d45c5d  author 2026-10-03 17:15:38 +0500   committer 2026-10-04 12:43:12 +0500
cdd0677  author 2026-10-03 17:26:36 +0500   committer 2026-10-04 12:43:12 +0500
7649fee  author 2026-10-04 06:27:03 +0500   committer 2026-10-04 12:43:13 +0500
```

One machine, four commits, one second apart, hours after the work they record. Those committer dates
are why this rewrite refuses to touch them: they are the evidence, and a script that reset them to
`now` would destroy the only proof that the four commits are a harness artifact.

## The five, one case each

**9621826, `WIP: checkpoint (auto)`** -- adds `probe.mjs`, `probe2.mjs`, `probe3.mjs`: a response
listener that prints the first `mtop` reply per API for any URL on argv, a walk of a fixed item id
asking which id field the detail payload carries (`sellerDO`, `itemDO`), and the same question of
`page.head` from a fixed `userId`. Three scripts, no explanation of why they exist or what they
found. The later `8ff22ce` lands the `seller_profile` chain these were measuring, so the work was
real; the record of it was not written.

**1d45c5d, `WIP: checkpoint (auto)`** -- wraps every `goto`, `waitForTimeout` and `evaluate` in a
`try`, adds `process.exit(0)`, and adds `probe4.mjs` reading the homepage's category links. The
guards are the interesting half: a page that never settles was hanging the session instead of
printing what it had seen.

**cdd0677, `WIP: checkpoint (auto)`** -- carries the same guards into `probe.mjs` and adds
`probe5.mjs`, which walks two entry points back to back (`mach-feeds`, and `search?q=x220` with
`cCatId` pinned) and prints each one's taps plus the first 160 characters of rendered body.

**7649fee, `WIP: checkpoint (auto)`** -- adds `probe6.mjs`, which stops listening on the network and
calls `window.lib.mtop.request` from inside the page: `page.head` with the userId, `page.head` with
nothing, and the search hit counter.

**4acf626, `WIP: TTL cache for item detail and search pages, staleness published (xi-byi)`** -- this
one is not machine-written and I want to be exact about that. It is authored by `capable`, its
committer date is fourteen minutes after its author date, and its body is 2,012 bytes of dense
reasoning. What it is, though, is the commit that ships `src/cache.ts` (206 new lines) and
`test/cache.test.ts` (153), and it opens by calling itself WIP. The body's own closing admission --
"WIP: not re-verified end to end" -- stays exactly where it is. That disclosure is the point of the
commit; it just does not belong in the subject line, where it hides what the commit actually did.
The subject claims a behaviour ("every hit publishes its own age") that the body already argues for.

**c554385, `WIP(mid-task xi-cln): capabilities freshness answer no longer waits for a browser
launch`** -- a sixth, from the same safety net with a different spelling, and not on `origin/main`; it
is on `local main` and `polecat/capable/xi-cln`. It is also not cruft: `642ccee` adds only
`README.md` and `CHANGELOG.md` on top of it, so this commit carries the `src/tools.ts` and `test`
changes that the next commit documents. Retitle it, never drop it. `scripts/humanize-history.mjs`
carries the mapping and reports it as `not in range` when you point the script at `origin/main`.

## The nineteen, and why each is left alone

The general case: every one of these names a mechanism a reader can check, carries a body that
commits to something specific, and is authored by the agent that did the work. A humanizer run over
them would have to either leave the sentences alone -- in which case it did nothing -- or rewrite
them into something less precise, which is the failure mode the request names.

- **7ab7d6b** `docs: CI badge, corrected test count, and the Python lineage` -- says where the Python
  original went and that `main` no longer holds it. A reader who did not know that could not have
  guessed it.
- **5d1bc7b** `chore: ignore agent tooling dirs` -- the reason is the polecat cleanup predicate, and
  that it blocks the rig from delegating. `chore:` here names a specific hazard, not "housekeeping".
- **e893f85** `perf: load Playwright lazily instead of at module scope` -- 4.0s to ~30ms, measured,
  and the 19M dependency off the startup path. The numbers are the subject's argument.
- **9b5b656** `docs: describe Playwright as an optional, lazily-loaded dependency` -- three lines
  that exist only because `e893f85` made them false. Correcting a doc the previous commit
  invalidated is the right-sized commit.
- **16d361a** `chore: regenerate package-lock.json for playwright as an optional dependency` --
  names the failure (`npm ci` resolved a different graph than `npm install`, and `--omit=optional`
  would not have spared it the download) rather than saying "update the lockfile".
- **f460a6e** `fix: advertise package.json's version instead of a second copy of it` -- the second
  copy was in `src/index.ts`, nothing compared the two, and the consequence is named: a client
  showed the previous release's number. That is a bug report and a fix in one subject.
- **6462d01** `docs: add a CHANGELOG, and say plainly that the history was squashed` -- documents the
  absence of history rather than inventing one. Reconstructing a history that was never recorded
  here would be the lie, and the commit says so in the file.
- **265a1cc** `feat: v0.2 search — env-tunable max-items cap and deeper results (xi-xqq)` -- names the
  env var, its range, the default and what moved (60 to 120, bounded to 300 rather than 500). This
  one uses bullets and an em dash; chy's style note says no bullets and no em dashes, and applying
  that here would be importing another repository's habits into one that does not share them.
- **d9a9ea7** `feat: every listing gains a typed block beside its strings, and names what it lacks
  (xi-srd)` -- the second half of the subject is the honest part: it lists what the payload carries
  and does not publish. A subject that admits its own gaps is the opposite of a generic one.
- **8ff22ce** `feat: seller_profile and seller_items -- the item -> seller -> listings chain (xi-e29)`
  -- the body explains the anti-bot stamping asymmetry that makes the route work. That is the hardest
  thing in the file to rediscover.
- **a352af4** `feat: the deployment says which commit is answering, so a stale dist cannot serve
  quietly (xi-bio)` -- opens with a concrete incident: a deploy nine commits and all of v0.2.0
  behind, answering plausibly, with a stale `origin/main` ref reporting "0 behind".
- **a135e74** `ci: pin the stamp check to CommonJS -- "type": "module" plus a detected eval loader
  makes a bare require a ReferenceError (xi-rre)` -- a CI bug pinned to its exact mechanism and the
  exact way it fails.
- **1038ed2** `docs: correct the buildBlock comment -- the no-throw guarantee lives in
  build-info.ts, not in a guard here (xi-rre)` -- corrects a comment that had drifted from the code,
  and says which file is authoritative. This is the pattern the machine commits have no version of.
- **9a3c44b** `fix: auto-save uncommitted implementation work (xi-rre, gt-pvx safety net)` -- this is
  the commit that *added* the safety net that produced the four checkpoint commits. Its subject is
  the maintainer naming the thing this whole exercise is about.
- **d9ce6a6** `chore: gitignore .pi/ alongside .claude/ and .opencode/ -- gt done's auto-save safety
  net committed the harness extension into the MR (xi-rre)` -- the subject reports a failure of the
  safety net with the consequence. Again: the maintainer, writing about the harness.
- **07f1c64** `docs+fix: document the TTL cache, and a comment the conflict swallowed (xi-byi)` --
  documents the `cache` block and restores a comment a rebase mangled. Both halves are real.
- **670db48** `perf: pay the first load at boot, and name a declined load in seconds (xi-x8x)` --
  names what changed and what a caller now sees instead of silence.
- **3c75906** `perf: the measurements, the corrected numbers, and the probes that took them (xi-x8x)`
  -- `item_view` cannot be an SPA route change: 0/8 answered in 32s against 8/8 for a full load.
- **92e4e9a** `feat: the spawn refuses to serve a dist it cannot vouch for (xi-pas)` -- states the
  refusal, which is the interesting half.

### The two that a stricter reviewer would flag

**a352af4** is authored by `xianyumcp/witness`, and the Witness is not a worker. That is an identity
anomaly rather than a voice one -- the message is dense, specific and correct, and the commit content
is the `buildBlock` work. If the maintainer wants authorship policy enforced rather than noted, this
is the commit to look at. I did not retitle it; the message has nothing wrong with it.

**a135e74, 1038ed2, 9a3c44b and d9ce6a6** carry a subject and little else: 132, 117, 76 and 144
bytes of message, most of which is a `Co-Authored-By` trailer. chy's history has no commit without a
body. Against them: four commits in twenty-one minutes with 6, 6 and 9 minute gaps, in a
deliberate order around one bead, each naming a different real mechanism, authored by a named
worker. That is a fast sequence of small edits, not a burst. If the bar is "every commit argues
something", these four are the next four and the mapping is four entries away in
`scripts/humanize-history.mjs`. If the bar is "no commit was written by a machine", they pass.

## The chy reference, read narrowly on purpose

`alperien/chy` cloned to `/tmp/chy`: thirty-six agent commits between 2026-09-06 and 2026-09-07, all
under `chytrans worker <agent@chy.local>` or `worker`, plus a human's own history under
`alperien`. Zero `WIP:` subjects. Zero empty bodies. Real multi-day timestamps.

Two things follow and one does not.

Follows: an agent writing a commit into a public history writes under an agent identity, never the
human's, and puts a reason under the subject. Both of those hold for nineteen of twenty-four commits
here and fail for the four checkpoints, whose author is the ambient identity.

Does not follow: chy's subjects use area prefixes (`chy:`, `translator:`, `ci:`, `evaluate.sh:`,
`golden:`) rather than conventional types, and chy's prose uses two spaces after every sentence
period. This repo's maintainer chose `feat:` / `fix:` / `chore:` / `perf:` / `docs:` / `ci:` and
single spaces, and has done so in all nineteen good commits, several of which are cited above. A
rule that would rewrite those nineteen is a rule imported from another repository's habit, not a
pattern found in the evidence. So: the new probe subjects below use `probe:` because the maintainer
already wrote the word -- "the probes that took them" -- and because a scratch script is an area, not
a change type. `chore:` is the alternative this repo uses for non-product work, and it would be
equally defensible; it is four constants at the top of the script if the maintainer prefers it.

## The dry run

`node scripts/humanize-history.mjs`, unmodified, against `origin/main`:

```
range origin/main: 24 commits
  not in range: c554385 (WIP(mid-task xi-cln): capabilities freshness answer no longer waits for a browser launch)

7ab7d6b    docs: CI badge, corrected test count, and the Python lineage
5d1bc7b    chore: ignore agent tooling dirs
e893f85    perf: load Playwright lazily instead of at module scope
9b5b656    docs: describe Playwright as an optional, lazily-loaded dependency
16d361a    chore: regenerate package-lock.json for playwright as an optional dependency
f460a6e    fix: advertise package.json's version instead of a second copy of it
6462d01    docs: add a CHANGELOG, and say plainly that the history was squashed
265a1cc    feat: v0.2 search — env-tunable max-items cap and deeper results (xi-xqq)
9621826 -> WIP: checkpoint (auto)
         -> probe: three measurement scripts -- mtop taps on any URL, the detail seller's ids, and the user page's baseInfo
1d45c5d -> WIP: checkpoint (auto)
         -> probe: a wedged page must still report, so every navigation is guarded -- plus the homepage's category links
cdd0677 -> WIP: checkpoint (auto)
         -> probe: the feed and search entry points, each printed with its mtop taps and the first 160 characters of body
7649fee -> WIP: checkpoint (auto)
         -> probe: lib.mtop.request called inside the page -- page.head with and without a userId, and the search hit counter
d9a9ea7    feat: every listing gains a typed block beside its strings, and names what it lacks (xi-srd)
8ff22ce    feat: seller_profile and seller_items -- the item -> seller -> listings chain (xi-e29)
a352af4    feat: the deployment says which commit is answering, so a stale dist cannot serve quietly (xi-bio)
a135e74    ci: pin the stamp check to CommonJS -- "type": "module" plus a detected eval loader makes a bare require a ReferenceError (xi-rre)
1038ed2    docs: correct the buildBlock comment -- the no-throw guarantee lives in build-info.ts, not in a guard here (xi-rre)
9a3c44b    fix: auto-save uncommitted implementation work (xi-rre, gt-pvx safety net)
d9ce6a6    chore: gitignore .pi/ alongside .claude/ and .opencode/ -- gt done's auto-save safety net committed the harness extension into the MR (xi-rre)
4acf626 -> WIP: TTL cache for item detail and search pages, staleness published (xi-byi)
         -> feat: a TTL cache on item detail and search pages, and every hit publishes its own age (xi-byi)
07f1c64    docs+fix: document the TTL cache, and a comment the conflict swallowed (xi-byi)
670db48    perf: pay the first load at boot, and name a declined load in seconds (xi-x8x)
3c75906    perf: the measurements, the corrected numbers, and the probes that took them (xi-x8x)
92e4e9a    feat: the spawn refuses to serve a dist it cannot vouch for (xi-pas)

base: 265a1cc stays at 265a1cc -- everything below it keeps its sha
sha changes for 16 of 24 commits: the retitled one and everything above it
tag refs/tags/v0.1.0 -> 9b5b656 is inside the rewritten range and would dangle

dry run: no object written, no ref moved. Re-run with --apply to write the result.
```

Verified on this repo, `--apply` and then read back: `git diff origin/main refs/heads/humanized/origin_main`
is empty, so the two tips are the same tree; every author line and every committer line in the new
chain is byte-identical to the old one (`toast`, `2026-10-05 20:36:09 +0500` /
`2026-10-05 23:40:11 +0500` at the top, unchanged); `265a1cc` is still an ancestor of the new tip;
and none of `9621826`, `1d45c5d`, `cdd0677`, `7649fee`, `4acf626`, `92e4e9a` is an ancestor of it
any more.

## What the script will and will not do

`scripts/humanize-history.mjs` rebuilds each commit as a raw object through
`git hash-object -t commit -w --stdin`, replacing the `parent` lines and, for the six mapped commits,
the first line of the message. It does not use `git commit-tree` or `git filter-branch`, because
both rebuild the header from parsed fields and can tidy a message or normalize a date on the way
through; reading the object and putting back everything except the two things being changed means
the author line, the committer line, the encoding header and every message byte under the subject
survive as they are.

It refuses rather than guesses:

- A mapping entry whose recorded subject does not match the commit in the repo aborts the run. If
  someone has already reworded that subject by hand, the script does not overwrite their wording.
- A signed commit aborts the run, because rewording invalidates the signature.
- A merge in the range aborts the run. The parent block is replaced with a single parent, so
  linearizing a merge would drop its second parent without saying so; this repo's history has none,
  and rewriting across one needs a decision about what the other parent should become.
- After every commit it re-reads the object and checks the tree, the author line, the committer
  line and the recorded parents, and for any commit nobody asked to edit it also checks the message
  bytes. A commit whose parents came out unchanged must hash back to itself.

`--apply` writes `refs/heads/humanized/<tip>` and stops. It moves no branch, touches no tag and runs
no network command. `test/humanize-history.test.mjs` builds a throwaway repository with the same
shape as this one and asserts the same properties, which is how the parent-line bug in the first
draft was caught: a rebuilt commit that kept its old parent and appended the new one as a second
line still has the right tree, the right message and a plausible subject, and the rewrite silently
does nothing.

## The three blockers, unblocked by nothing here

**A force-push is not available.** `gtw-1yi` reports the pr-workflow tap guard exiting 2 in an agent
context, which is why nothing in this work was pushed and why `main` on the remote is untouched.

**`refs/tags/v0.1.0` points at `9b5b656`, which is a descendant of all four checkpoints.** A rewrite
orphans that tag. The published v0.1.0 release page then resolves to a commit that is no longer on
the branch, and the release has to be re-tagged by hand at whatever the new sha for `9b5b656` turns
out to be. Zero forks and zero stars means nobody's clone breaks, but the release link does, and the
script says so in its output rather than letting it be discovered later.

**Seventeen remote branches exist**, several carrying do-not-merge annotations that live in beads
rather than in git. The script touches no remote ref at all, and the maintainer is the only one who
can decide what happens to the branches that point into the rewritten range.

## What this does not fix

`probe.mjs` through `probe11.mjs` are still tracked at the repository root: eleven scratch scripts,
six of them added by the four checkpoint commits. They are not in `package.json`'s `files`, so they
do not ship to npm, but they are in the tree and in the GitHub tarball. Deleting them is a content
change and therefore outside the scope of this bead, which is why it is filed separately rather than
done here. It is also a genuine question: `3c75906` treats those probes as the evidence behind the
latency numbers in the README, so whether they stay is the maintainer's call about provenance, not
about tidiness.
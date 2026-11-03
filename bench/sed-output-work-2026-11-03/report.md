# sed edits that stopped at the expansion-work limit, 2026-11-03

Problem: a large `sed` edit stopped part way. Over the 10,000-page wiki,
`sed -i 's/owner/OWNER/' /wiki/*/*.md` rewrote 1,654 of the 6,822 pages that
contain the word and failed with "shell expansion work limit exceeded";
`sed 's/a/b/' /wiki/sales/*.md` stopped after 4,973,449 bytes of output, and a
global substitution over the wiki failed outright. `awk`, `grep` and `cat`
over the same input do not stop this way.

## Cause

Expansion work (10,000,000 units by default) bounds work that the bytes a
command reads do not (`docs/operations.md`). sed charged it for text it only
copied:

- every character it printed, although what reaches a pipe or a file is
  bounded by that sink's byte limits, as it is for `awk`, `grep` and `cat`,
  none of which charge output as expansion work;
- every character of a record it rebuilt after a substitution — the
  unchanged parts are text it read — and the replacement a second time,
  after `expandReplacement` had charged it.

So a substitution cost about three units per character of a matching record,
and five million characters of edited text used up the limit.

## Change

- Echoing what a cycle read is free: autoprint, `s///p`, `-i`. Printing beyond
  that — `p;p`, `i`, `a`, `c`, `=` — is still charged, since `/dev/null`
  charges nothing for it.
- A rebuilt record is assembled without a charge (its length limit and the
  buffered-bytes check still apply), and a replacement charges only its
  growth over the text it replaces; each match attempt of a global or
  numbered substitution still charges one unit.
- A branch back or a `D` restart that read no record since the last one
  charges the pattern space's length: such a loop runs the script over the
  same text again. Loops that read as they go (`:a;N;$!ba`, `$!N;P;D`) are
  bounded by their input as before.

`test/sed-expansion-work.test.ts` holds both sides: loops and repeated
printing that read nothing new stop at the expansion-work limit, and
input-driven idioms and edits run. `test/sed-replacement-limits.test.ts`
states the growth rule. `npm run test:limits` passes.

## Results

Node over the 10,000-page wiki (`node-wiki.log`): `sed -i 's/owner/OWNER/'`
completes, 6,822 pages rewritten in 533 ms, where main stopped after 1,654;
`sed 's/e/E/g'` over every page completes in 1.2 s where main failed.

Local workerd, main (b9283cb) beside this branch, one run each
(`local-workerd-outcomes.log`): `sed 's/a/b/' /wiki/sales/*.md | wc -c` prints
all 5,189,170 bytes where main stopped at 4,973,449; `sed 's/e/E/g'` over the
wiki completes in 1.3 s where main failed.

Timing, ten alternating pairs on commands main completes
(`local-workerd-pairs.jsonl`, the code as committed; the first version is in
`local-workerd-pairs-before-review.jsonl`), same output in every pair:

| Command | ratio (95% bootstrap) |
| --- | ---: |
| `sed -n 's/owner/OWNER/p' /wiki/*/*.md \| wc -l` | 0.991 (0.973–1.011) |
| `sed 1d /wiki/legal/*.md \| tail -1` | 0.944 (0.919–0.970) |
| `cat /wiki/sales/*.md \| sed 's/x/y/' \| wc -l` | 0.983 (0.959–1.004) |

Full local suite on the first version (`bench:local:paired`, `local-group-v1`, full plan, four
sessions with `ORDER_OFFSET` 0, 1, 0, 1; `local-paired-s1..4.json`,
`../summarize-local-pairs.mjs`): overall 0.997, families 0.988–1.001. Of the
three workloads above 5%, two are in the `git` family, which runs no shell
code; `coding-small/commit-partial/100` (1.069, sessions 0.90–1.20) is a Git
commit and runs no sed.

## Reviews

Two independent reviews ran the first version against main over 3,600 random
scripts and 800 tight-limit cases: output byte-identical wherever main
completed. Both found that it removed two bounds: a script printing the same
pattern space many times to `/dev/null` (2,000 `p` on a 1 MB line wrote about
2 GB before the deadline), and a substitution loop that reads nothing
(`:a;s/x/x/;ta`), which relied on the record-rebuild charge. One also found
an older hole: `:a;/[yz]q/!ba` rescans a large space on one step each, about
45 minutes of synchronous work at the default step limit. The echo allowance
and the charge for loops that read nothing close all three. Joining a whole
file with `:a;N;$!ba` still costs what it did (13.9 KB of 1,500 lines exceeds
the default limit before and after), as `N` charges the space it builds.

## Behaviour that differs

sed runs longer before its expansion-work limit when it echoes what it reads
or makes text smaller or no larger; it stops sooner when a loop reads
nothing new, which before could run until the step limit or the deadline.

## Bundle size

Two presets went over their budgets and were raised to their measured size
rounded up to 128 bytes: default-registry 646,272 (+1,792), linux-profile
857,728 (+1,664).

# awk edits that stopped at the expansion-work limit, 2026-11-03

Problem: an ordinary per-record `awk` edit stopped part way over a large
tree. Over the 8,055 pages of the 10,000-page wiki,
`awk '{ gsub(/e/, "E"); print }' /wiki/*/*.md > /dev/null`,
`awk '{ $1 = $1; print }'`, `awk '{ n += gsub(/a/, "a") } END { print n }'`
and `awk '{ x = $0 "!" }'` failed with "shell expansion work limit
exceeded". `sed` had the same fault until #139.

## Cause

awk charged expansion work (10,000,000 units by default) for every character
of text it built: a `sub`/`gsub` result, a rebuilt `$0`, a concatenation, an
array key, `sprintf`. Editing each record once therefore cost about the size
of the input, and an input over ten million characters could not be edited.

## Change

- Each record read grants an allowance of its length and newline
  (`state.buildAllowance`, set in the record loop of `awk.ts`); building
  text spends the allowance before it charges expansion work
  (`chargeAwkBuild` in `awk-strings.ts`, used by `joinAwkStrings`, `sub`/
  `gsub` and `sprintf`). The allowance is renewed per record and not carried
  forward, so text built without a charge never exceeds what was read.
- Assigning `$0` reads nothing and renews nothing; `BEGIN` and `END` build
  with no allowance; loops still charge a unit per iteration.

`test/awk-expansion-work.test.ts` holds both sides: per-record edits, keys
and copies run over 13,000 characters against a limit of 1,000 units of
work, and growth, repeated rebuilds of one record, building in loops, in
`BEGIN` or `END` and accumulation stop at it.

## Results

Local workerd, main (92030a8) bundled beside this branch, one run each over
the 10,000-page wiki (`local-workerd-outcomes.log`):

| Command | main | this branch |
| --- | --- | --- |
| `awk '{ gsub(/e/, "E"); print }' /wiki/*/*.md > /dev/null` | expansion work limit | completes, 1.2 s |
| `awk '{ $1 = $1; print }' /wiki/*/*.md > /dev/null` | expansion work limit | completes, 0.67 s |
| `awk '{ n += gsub(/a/, "a") } END { print n }' /wiki/*/*.md` | expansion work limit | 2,738,268, 0.88 s |
| `awk '{ x = $0 "!" } END { print NR }' /wiki/*/*.md` | expansion work limit | 504,249, 0.35 s |

Piping the whole edited wiki to another command (`| wc -c`) stops at the
8 MiB pipeline-edge limit on both, as `cat` over it does.

Timing, ten alternating pairs on commands main completes
(`local-workerd-pairs.jsonl`), same output in every pair:

| Command | ratio (95% bootstrap) |
| --- | ---: |
| `awk '{ n += gsub(/owner/, "x") } END { print n }' /wiki/sales/*.md` | 0.967 (0.958–0.977) |
| `awk '{ gsub(/owner/, "OWNER"); print }' /wiki/legal/*.md \| wc -l` | 0.969 (0.958–0.979) |
| `awk '{ $1 = $1; print }' /wiki/legal/*.md \| wc -l` | 0.971 (0.955–0.985) |
| `awk '{ print $1 }' /wiki/sales/*.md \| wc -l` | 0.996 (0.975–1.013) |

Full local suite on the code as committed (`bench:local:paired`,
`local-group-v1`, full plan, four sessions with `ORDER_OFFSET` 0, 1, 0, 1;
`local-paired-s1..4.json`, `../summarize-local-pairs.mjs`): overall 1.001,
families 0.995–1.006; SQL statements 2,097,229 → 2,097,235, rows read
2,096,846 → 2,096,823. The four workloads above 5% — `git/diff/1000`
(1.123), `git/branch/1000` (1.091), `git-shell/commit/100` (1.062),
`coding-mixed/commit-partial/1000` (1.062) — run Git and no awk. Twelve
pairs in two sessions over their groups (`local-paired-recheck-o0/1.json`):
overall 1.001; they measured 0.922, 1.030, 0.997 and 1.003, and one other
Git workload, `git/commit/1000`, rose to 1.053 (sessions 1.07, 1.04).

## Reviews

Two independent reviews. One compared main with this change over 7,000
random programs at tight and unlimited budgets: no difference in output,
stderr or status in the 2,313 cases main completes, the 110 it stopped now
print what an unlimited budget prints, and no case charges more units than
main — by construction, as a charge is `max(0, length − allowance)` and the
allowance is set, not added, per record. Trying to farm the allowance with
two million empty records stops at the record limit; recursion stays capped
at 64 calls of a unit each. A same-length `gsub` over 32 MiB of 1 MiB
records now runs about 3.3 s instead of stopping at 1 s: file input is
bounded by the file-read limit and the deadline, as `toupper($0)` and
`gsub(/b/, "")` already were on main.

The other found the logic sound and asked for: `END` not to inherit the last
record's leftover (it now starts at zero, as `BEGIN` does), tests that pin
`$0 = …` renewing nothing, several files and stdin, `!seen[$0]++`, and a
loop test that failed for the wrong reason, and the docs: `docs/commands.md`
now describes the charge, and `docs/operations.md` no longer says awk loops
charge the loop-iteration limit (they charge expansion work).

## Behaviour that differs

awk runs longer before its expansion-work limit when it builds no more text
per record than the record it read. A second rebuild of the same record
(`$3 = ""; $4 = ""`) is still charged in full, unlike sed's rebuilt records;
that is not a regression and is left for later.

## Bundle size

The awk preset went over its budget and was raised to its measured size
rounded up to 128 bytes: 122,624 (+256).

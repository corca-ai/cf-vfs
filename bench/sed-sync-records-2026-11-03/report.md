# sed without an await per step, 2026-11-03

Goal: make `sed` over many files cheaper on Workers, where an `await` costs
0.12 µs (0.019 µs on local workerd). Follows #132 (grep) and #133 (awk),
which removed per-line awaits from those commands. Measured locally only:
the SQL lab on local workerd and the full local suite. No Cloudflare usage.

## Where the cost was

`SedRunner` was a chain of async methods — reading a record, the cycle,
each command's step, its address test, its execution, every emit and the
output's write — so one record cost ten or more awaits, and the records
came through an async generator with one record of lookahead for `$`.

## Change

- The runner's steps are a generator that yields only a promise it has to
  wait on: a record that is not at hand, or output that must reach its sink.
  `drive` runs it synchronously and awaits only what it yields
  (`src/shell/commands/sed-records.ts`).
- `LineSource` hands out the records of a body read in bulk synchronously;
  only a stream, or moving on to the next input, returns a promise. The
  lookahead for `$` and closing the input on `q` work as before.
- `SedOutput` writes through `BufferedTextWriter.put`, so output awaits only
  when a 64 KiB slab reaches the sink.
- `sed -i` splits the file's text into records with the same source.
- Text that is never awaited is written by plain functions (`emit`,
  `autoprint`, `printed`), and an empty queue of appended text is skipped,
  so a record makes few generator steps.

`test/sed-bulk-lines.test.ts` runs 28 scripts — `$` across files and with
stdin, ranges, `n`, `N`, `D`, `P`, `a`, `i`, `c`, `y`, `q`, `Q`, `=`, hold
space, output past the 64 KiB slab, a file without a final newline, invalid
UTF-8, empty files, `| head -1`, `-i` — and compares bulk against per-file reads at 4 KiB
and 7-byte chunks. Its outputs at both chunk sizes are byte for byte those of
the previous sed.

## Results

Local workerd, main (2ce15c9, v0.5.2) bundled beside this one, both warmed,
ten alternating pairs over the 10,000-page S3 wiki
(`local-workerd-pairs.jsonl`, the code as committed; the version before the
reviews measured 0.597, `local-workerd-pairs-before-review.jsonl`), outputs
identical in every pair:

| Command | before | after | ratio (95% bootstrap) |
| --- | ---: | ---: | ---: |
| `sed -n 's/owner/OWNER/p' /wiki/*/*.md \| wc -l` | 519 ms | 278 ms | 0.545 (0.528–0.565) |
| `sed -n '$=' /wiki/*/*.md` | 464 ms | 232 ms | 0.501 (0.489–0.517) |
| `sed -n '/owner/p' /wiki/*/*.md \| wc -l` | 479 ms | 255 ms | 0.534 (0.527–0.540) |
| `sed 's/a/b/' /wiki/sales/*.md \| wc -c` | 90 ms | 51 ms | 0.568 (0.556–0.580) |
| `sed '1d' /wiki/legal/*.md \| tail -1` | 71 ms | 35 ms | 0.509 (0.496–0.523) |
| `cat /wiki/sales/*.md \| sed 's/x/y/' \| wc -l` | 83 ms | 61 ms | 0.701 (0.686–0.718) |
| `sed -i 's/zqzq/zqzq/' /wiki/ops/*.md` | 87 ms | 59 ms | 0.682 (0.672–0.694) |
| geometric mean | | | 0.573 |

A stream input still awaits each chunk and line from the pipe, and `-i`
also writes every file, so those gain less. Await costs are about five
times higher on Cloudflare than on local workerd, in line with JavaScript
there generally, so the ratios should carry over roughly; not measured on
Cloudflare.

`sed 's/a/b/' /wiki/sales/*.md | wc -c` stops, in both versions, at the
shell's expansion-work limit after about 5 MB of output: sed charges every
character it prints as expansion work. That is existing behaviour, measured
here as it is; whether printing should count against that limit is a
separate question.

Full local suite on the code as committed (`bench:local:paired`,
`local-group-v1`, full plan, four sessions with `ORDER_OFFSET` 0, 1, 0, 1;
`local-paired-s1..4.json`, `../summarize-local-pairs.mjs`): overall 1.000,
families 0.995–1.005; the suite's workloads use sed only in Git recovery
fixtures. Two workloads were above 5%, `git/diff/1000/cache` (1.077, from
one session at 1.43) and `git/status-change/100/cache` (1.054); the `git`
family calls isomorphic-git on the filesystem directly and runs no shell
code. The version before the reviews (`before-review/`) measured 1.002, and
twelve pairs in two sessions over the groups it flagged put them at
0.996–1.002 with none above 5%. SQL replay differences are a few statements
or rows in Git workloads, as in A/A controls.

## Reviews

Two independent reviews compared HEAD with this change: one over 9,240
runs (51 scripts, 16 file shapes including empty files, CRLF and invalid
UTF-8, stdin streams mixed with files, `sed -i` on every shape), every
limit, a deadline at each of 159 clock reads and 120 cases of cancelling
or timing out while sed waits on stdin, in Node and in workerd; the other
over 31 edge scripts under three limit settings. Output, errors, limit
events, exit status and stdin pulls and cancels were identical except for
how far a concurrent upstream stage got. Their findings — closing the
inputs even if closing the current one fails, three comments the rewrite
had dropped, a doubled doc comment, the driver's synchronous throw left
undocumented, naming, test assertions by position — are fixed, and empty
inputs are now in the test.

## Behaviour that differs

Concurrent pipeline stages interleave differently, because sed yields to
the next stage less often, as with #132 and #133.

## Bundle size

Two presets went over their budgets and were raised to their measured size
rounded up to 128 bytes: default-registry 641,920 (+2,944), linux-profile
853,504 (+2,944), the generator machine and its record source.

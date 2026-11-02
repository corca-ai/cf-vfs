# Fewer awaits and listeners per line and chunk, 2026-11-03

Goal: cut what commands pay per line and per chunk on Workers, where an
`await` costs 0.12 µs, an async generator step 0.29 µs and an abort listener
3.1 µs (0.019, 0.057 and 0.47 µs on local workerd,
`../local-workerd-2026-11-02/micro.log`). Follows #132, which did this for
grep's line splitting. Measured locally only: the SQL lab on local workerd and
the full local suite. No Cloudflare usage.

## Change

- **Abort listeners.** `readWithAbort` added and removed a listener on the
  execution's signal for every read — two runtime crossings per chunk on
  Workers. `watchReader` watches a reader once, from `getReader` to
  `releaseLock`: a read under way when the signal aborts fails at once with
  the cancellation and the reader is cancelled with it, and after an abort
  the next read fails before it starts, as racing each read against the
  signal did. It keeps the aborted state in JavaScript, so a read does not
  ask the runtime for `signal.aborted` either.
- **Buffered output.** `BufferedTextWriter.put` buffers without a promise
  unless the 64 KiB slab must reach its sink, so a command printing line by
  line awaits once per slab instead of once per line.
- **awk.** Its interpreter is synchronous; only flushing output was async.
  `executeRules` and `AwkOutput.flush` now return a promise only when output
  must reach a sink, and records of a bulk-read body run in a plain loop.
- **Shared line iteration.** `textLines` and `eachLine` (helpers.ts) give
  grep and awk the same synchronous iteration of bulk bodies; grep prints a
  selected line without context options through `put`.
- Not done: `sed` reads records through a one-record lookahead over an async
  generator and runs an async executor; making that synchronous is a larger
  change, left for later.

`test/awk-bulk-lines.test.ts` compares bulk against per-file reads over 15
awk programs (FILENAME/FNR/NR, `exit`, END, redirection to a file and to
`/dev/stderr`, output past the 64 KiB slab, invalid UTF-8, `| head -1`) at
4 KiB and 7-byte chunks; it passes before and after. The grep cases of
`test/grep-bulk-lines.test.ts` still pass.

## Results

Local workerd, main (e803715) bundled beside this one, both warmed, ten
alternating pairs over the 10,000-page S3 wiki (`local-workerd-pairs.jsonl`,
the code as committed; the version before the reviews measured 0.887,
`local-workerd-pairs-before-review.jsonl`), outputs identical in every pair:

| Command | before | after | ratio (95% bootstrap) |
| --- | ---: | ---: | ---: |
| `awk '{ print $1 }' /wiki/*/*.md \| wc -l` | 692 ms | 542 ms | 0.782 (0.777–0.785) |
| `awk 'FNR == 1' /wiki/*/*.md > /dev/null` | 339 ms | 238 ms | 0.703 (0.695–0.710) |
| `awk '/owner/ { n++ } END { print n }' /wiki/*/*.md` | 358 ms | 254 ms | 0.710 (0.704–0.715) |
| `grep -rn owner /wiki \| tail -1` | 249 ms | 247 ms | 0.997 (0.982–1.009) |
| `grep -h owner /wiki/*/*.md \| wc -l` | 205 ms | 203 ms | 0.985 (0.976–0.994) |
| `wc -l /wiki/*/*.md \| tail -1` | 223 ms | 214 ms | 0.970 (0.962–0.979) |
| `cat /wiki/sales/*.md \| wc -l` | 28 ms | 26 ms | 0.946 (0.915–0.978) |
| `cat /wiki/legal/*.md \| tr a-z A-Z \| wc -c` | 89 ms | 88 ms | 0.985 (0.976–0.995) |
| `cat /wiki/sales/*.md \| md5sum` | 156 ms | 155 ms | 0.992 (0.986–0.999) |
| geometric mean | | | 0.888 |

awk gains most: every record awaited the rule runner before. grep printed
few lines here (`owner` is on one line of most pages), so `put` changes
little for it. The stream readers (`wc`, `tail`, `tr`, `md5sum`) save the
listener pair per chunk; on Cloudflare a listener costs about seven times
more than locally, so that part should weigh more there. Not measured on
Cloudflare.

Full local suite on the code as committed (`bench:local:paired`,
`local-group-v1`, full plan, four sessions with `ORDER_OFFSET` 0, 1, 0, 1;
`local-paired-s1..4.json`, `../summarize-local-pairs.mjs`): overall 1.000,
families 0.993–1.006. Six workloads were above 5%. `git-shell/commit/100`
was above 5% here and in the suite of the version before the reviews
(`before-review/`), so its groups were rechecked with twelve pairs in two
sessions (`local-paired-recheck-o0/1.json`): groups 0.990–1.009, the six no
longer above 5%, and `git-shell/commit-one/100` at 1.054. An A/A control,
this version against itself over the same groups and twelve pairs
(`local-paired-aa.json`), put `coding-mixed/checkout-main/100` at 1.157 and
`git/log/1000` at 1.122, so these are within the suite's noise; the `git`
family does not run the shell at all. SQL replay differences are a few
statements or rows in Git workloads, as in A/A controls.

## Reviews

Two independent reviews compared HEAD with this change: one over 2,144
cases (72 scripts, 8 limit settings, two chunk sizes, bulk and per-file
reads) and 100 cancellation scenarios, the other over 17 awk and grep
scripts, 500 random writer sequences and per-line promise counts.

Both found that the first version could not cancel a command waiting on
host-provided stdin: cancelling the execution or passing its deadline left
`cat`, `wc`, `grep`, `awk` and a dozen others waiting forever. It relied on
cancelling the reader to end a pending read, and the shell's stdin wrapper
cannot cancel its source while its own read holds the lock. HEAD rejected
the pending read itself, which hid that. The watch now rejects a pending
read at once, as HEAD did; that also restored two smaller differences the
reviews found (the reason a host's stdin is cancelled with, and an exit
status under a tight I/O limit). `test/shell-runtime-cancellation.test.ts`
now cancels 12 stdin readers, and lets the deadline pass on them, after
their first pull; all 24 fail on the first version and pass on HEAD and on
this one. The existing test cancelled before the first pull and so missed
it.

Also from the reviews: `signal.aborted` is no longer read twice per read,
`eachLine` does not await a boolean, `put`'s ordering contract is
documented, the stale comment and the exported `from` parameter in awk are
gone, and `watchReader` lives in its own module to keep `helpers.ts` within
the quality limits.

## Behaviour that differs

Concurrent pipeline stages interleave differently, because awk and grep
yield to the next stage less often, as with #132.

The lab's paired comparison shows different error messages for a glob that
matches nothing: the baseline's shell runs on the candidate's filesystem in
that scaffolding, and its `instanceof VfsError` checks do not recognise the
other copy's errors. Run in one copy (Node), both versions print the same.

## Bundle size

Six presets went over their budgets and were raised to their measured size
rounded up to 128 bytes: awk 121,600 (+2,560: the synchronous record loop
and flush), default-registry 638,976, linux-profile 850,560, awiki 115,584,
commands 30,976, ls 22,784 (each reaches `helpers.ts`, now with the line
iteration helpers and `put`).

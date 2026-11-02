# grep without an await per line, 2026-11-03

Goal: make `grep` over many files cheaper on Workers, where an `await` costs
0.12 µs and an async generator step 0.29 µs (0.019 and 0.057 µs on local
workerd, `../local-workerd-2026-11-02/micro.log`). Measured locally only: the
SQL lab on local workerd and the full local suite. No Cloudflare usage.

## Where the cost was

For a body read in bulk, grep split lines with the synchronous
`chunkTextLines`, but through the async `readTextLines` and a `for await`
loop, and awaited `consider` for every line even when nothing was printed.
That is two awaits per line — about 1,000,000 lines for `grep -rc` over the
10,000-page wiki. A body that could match was also decoded twice: once by
the prefilter that rules bodies out, again while splitting.

## Change

- A bulk body is split by `chunkTextLines` in a plain `for` loop (`for
  await` awaits every value even of a synchronous iterable).
- `consider` and `GrepContext.unselected` return at once when nothing is
  printed; a line is awaited only when it writes output.
- A one-chunk body (any body up to 256 KiB) is split from the text the
  prefilter decoded.
- Streams (stdin, per-file reads) take the old path unchanged.

`test/grep-bulk-lines.test.ts` compares bulk against per-file reads over 25
grep invocations — context, `-m`, `-o`, `-v`, `-c`, `-l`, `-L`, `-q`, `-r`,
an invalid UTF-8 file, a BOM, a line over the limit, `| head -1` — at 4 KiB
and 7-byte chunks; it passes before and after the change.

## Results

Local workerd, the PR #131 shell (6378311) bundled beside this one, both
warmed, ten alternating pairs over the 10,000-page S3 wiki
(`local-workerd-pairs.jsonl`, the code as committed; the version before the
reviews' restructuring measured 0.823, `local-workerd-pairs-before-review.jsonl`),
outputs identical in every pair:

| Command | before | after | ratio (95% bootstrap) |
| --- | ---: | ---: | ---: |
| `grep -rc owner /wiki \| tail -1` | 366 ms | 286 ms | 0.785 (0.774–0.796) |
| `grep -c owner /wiki/*/*.md \| tail -1` | 301 ms | 238 ms | 0.790 (0.783–0.799) |
| `grep -rl owner /wiki \| wc -l` | 241 ms | 233 ms | 0.966 (0.958–0.975) |
| `grep -rn owner /wiki \| tail -1` | 386 ms | 289 ms | 0.746 (0.741–0.751) |
| `grep -h owner /wiki/sales/*.md \| wc -l` | 40 ms | 29 ms | 0.729 (0.711–0.744) |
| `grep -rv owner /wiki/legal \| wc -l` | 59 ms | 52 ms | 0.881 (0.871–0.893) |
| `grep -rq owner /wiki` | 9 ms | 8 ms | 0.965 (0.932–1.000) |
| `grep -rC1 owner /wiki/ops \| wc -l` | 39 ms | 28 ms | 0.718 (0.705–0.733) |
| geometric mean | | | 0.817 |

`-l` stops at a file's first match and `-q` at the first match overall, so
they split few lines and gain little. Await and generator costs are about
five times higher on Cloudflare than on local workerd, in line with
JavaScript there generally (calibration), so the ratios should carry over
roughly; not measured on Cloudflare.

Full local suite (`bench:local:paired`, `local-group-v1`, full plan, four
sessions with `ORDER_OFFSET` 0, 1, 0, 1; `local-paired-s1..4.json`,
`../summarize-local-pairs.mjs`): overall 1.002, families 0.995–1.009. The
suite runs no `grep` (only the agent task series does). Four workloads were
above 5%, each from one or two sessions; twelve pairs in two sessions over
their groups (`local-paired-recheck-o0/1.json`) put the groups at 0.997 and
0.999 with none of them above 5%, and `coding-mixed/commit-partial/1000`, a
Git commit, at 1.060. SQL replay: 2,097,234 statements before and 2,097,254
after, rows read 2,096,825 and 2,096,846; the differences are in Git
workloads, as in A/A controls. The suite ran the version before the reviews'
restructuring, which moved code and simplified the loop without changing
what runs per line.

## Reviews

Two independent reviews compared HEAD with this change: one over 6,956 cases
(80 scripts, 21 limit settings including a deadline on a counting clock, two
chunk sizes, bulk and per-file reads, abort), the other over 33 scripts at
four limit settings. Every single command printed the same stdout and stderr
and exited the same. They found the quality lint over its file-length and
complexity limits (fixed by moving `operandInputs` beside `recursiveInputs`
and simplifying the loop), a stale comment and unclear names (fixed).

## Behaviour that differs

Concurrent pipeline stages interleave differently, because grep yields to
the microtask queue less often: in `{ grep -c . many.md; echo A >&2; } | {
loop N; echo B >&2; }` the order of A and B flips at a smaller N, and when
two stages share a limit, which of them reaches it first can change. Bash
does not define that order either, and any faster grep moves it. Deadlines
and cancellation are still checked once per chunk, as before.

## Bundle size

Three presets went over their budgets and were raised to their measured size
rounded up to 128 bytes: awk 119,040 (+128), default-registry 636,288
(+1,408), linux-profile 847,872 (+1,536).

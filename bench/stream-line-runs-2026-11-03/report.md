# Piped input without an await per line, 2026-11-03

Goal: make `cmd | grep`, `cmd | awk` and `cmd | sed` as cheap per line as
reading files, which #132, #133 and #135 made synchronous. Measured locally
only: the SQL lab on local workerd and the full local suite. No Cloudflare
usage.

## Change

- A stream (a pipe, stdin, a file read as a stream) is read as runs, one per
  chunk (`streamLineRuns` in `src/shell/commands/line-reader.ts`, the line
  splitting moved out of `helpers.ts`). A run hands out the chunk's lines
  synchronously and takes each — checking the line and record limits — only
  when asked for, where reading line by line takes it; at its end it checks
  the partial line left behind, and for the end of the stream it yields that
  partial line as the last record. A limit a run trips ends the stream, which
  is cancelled with that error.
- grep and awk (`textLines`/`eachLine`) and sed (`LineSource`) iterate runs,
  awaiting once per chunk rather than once per line.
- `readTextLines`, used line by line by `cut`, `uniq`, `nl`, `fold`, `xargs`
  and others, keeps its own direct loop.
- A line's length is measured only when it could exceed the limit: UTF-8
  never takes more than three bytes per UTF-16 unit.

## Results

Local workerd, main (97c4758) bundled beside this branch, both warmed, ten
alternating pairs over the 10,000-page S3 wiki (`local-workerd-pairs.jsonl`,
the code as committed; earlier versions in `local-workerd-pairs-before-review.jsonl`),
outputs identical in every pair:

| Command | before | after | ratio (95% bootstrap) |
| --- | ---: | ---: | ---: |
| `cat /wiki/sales/*.md \| grep -c owner` | 30 ms | 26 ms | 0.863 (0.846–0.881) |
| `cat /wiki/sales/*.md \| grep -v x \| wc -l` | 38 ms | 34 ms | 0.887 (0.875–0.899) |
| `cat /wiki/sales/*.md \| awk '{ print $1 }' \| wc -l` | 75 ms | 70 ms | 0.922 (0.910–0.934) |
| `cat /wiki/legal/*.md \| awk 'END { print NR }'` | 30 ms | 26 ms | 0.869 (0.854–0.882) |
| `cat /wiki/sales/*.md \| sed 's/x/y/' \| wc -l` | 49 ms | 40 ms | 0.835 (0.817–0.857) |
| `grep -h owner /wiki/*/*.md \| sed 's/owner/O/' \| wc -l` | 208 ms | 202 ms | 0.972 (0.966–0.978) |
| `cat /wiki/sales/*.md \| cut -c1-8 \| wc -l` | 52 ms | 52 ms | 0.988 (0.959–1.019) |
| `cat /wiki/sales/*.md \| uniq \| wc -l` | 72 ms | 71 ms | 0.982 (0.971–0.995) |
| geometric mean | | | 0.913 |

The last stage of most of these, `wc`, is unchanged, and `grep -h glob |
sed` spends most of its time in grep reading 8,055 files. An earlier version
built `readTextLines` on runs, which added a generator step per line: `cut`
and `uniq` measured 1.019 and 1.017; it was given back its own loop.

Full local suite on the code as committed (`bench:local:paired`,
`local-group-v1`, full plan, four sessions with `ORDER_OFFSET` 0, 1, 0, 1;
`local-paired-s1..4.json`, `../summarize-local-pairs.mjs`): overall 0.996,
families 0.992–1.002. The two workloads above 5%, `git/commit/1000/cache`
(1.059, from one session at 1.23) and `git/status-clean/1000` (1.054), are in
the `git` family, which calls isomorphic-git directly and runs no shell code.
The version before the reviews (`before-review/`) measured 1.003, and twelve
pairs in two sessions over the shell-using groups it flagged
(`before-review/local-paired-recheck-o0/1.json`) put them at 1.010 and 1.000
with none above 5%.

## Reviews

Two independent reviews compared main with this change over 3,429 cases —
every line-reading command, host stdin in 15 chunkings (one byte per chunk,
empty chunks, a character split across chunks, invalid UTF-8, an upstream
error, a deadline), five limit settings, early stops at the start, middle
and end of a run — recording output, exit status, chunks pulled and the
reason the upstream stream was cancelled with: no difference. They found the
rule that a caller drain a run before asking for the next fragile (a caller
that did not would have seen a false line-limit error and a merged last
record), `readTextLines` built on runs costing a microtask turn more per
line, and an extra await per bulk-read file in `eachLine`; all three are
fixed, and the module is named apart from `text-lines.ts`.

## Behaviour that differs

Concurrent pipeline stages can interleave differently, as with #132, #133
and #135, since a piped command yields to the next stage once per chunk.

## Bundle size

Three presets went over their budgets and were raised to their measured
size rounded up to 128 bytes: awk 122,368 (+768), default-registry 644,480
(+2,560), linux-profile 856,064 (+2,560).

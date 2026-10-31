# Runtime costs after bulk reads — 2026-10-31

What stayed slow on Cloudflare once reads were bulk: `awk`'s work per
record, a line written to a pipe, and `awiki`'s parse.

## Method

Sessions minutes apart differed by as much as 2x, more than the changes, so
redeploying the lab between versions (`runtime-costs-2026-10-31.mjs`,
`runtime-costs-2026-10-31-wiki10k.jsonl`, labels `before-*`, `after-*`,
`variant-b`) only screened. The adopted comparison bundles main's shell
beside the candidate's in one lab deployment
(`runtime-pairs-lab-scaffolding-2026-10-31.patch.txt`, not committed to the
lab) and alternates them in pairs on the same Durable Object
(`runtime-pairs-2026-10-31.mjs`, `runtime-pairs-summary.mjs`). Microbenchmarks
come from `micro-2026-10-30.mjs` (`micro-before-2026-10-31.log`,
`micro-after-1-2026-10-31.log`).

## Microbenchmarks (per operation)

| Operation | Before | After |
| --- | ---: | ---: |
| `utf8ByteLength` of a 200-character ASCII line | 1.09 µs | 0.06 µs |
| a short line written to the shell's pipe and drained | 20.8 µs | 9.8 µs |
| `normalize("NFC")` of a short ASCII name | 0.14 µs | (unchanged; not worth a fast path) |

## Commands, paired in one deployment (8 pairs, 10,000-page wiki)

| Command | Main | Candidate | Ratio (95% bootstrap) |
| --- | ---: | ---: | ---: |
| `awk 'FNR == 1' /wiki/*/*.md > /dev/null` | 2,719 ms | 1,682 ms | 0.645 (0.593–0.713) |
| `awk '{ print $1 }' /wiki/*/*.md \| wc -l` | 5,132 ms | 3,835 ms | 0.734 (0.685–0.788) |
| `awiki lint -r -root /wiki`, cold | 3,452 ms | 2,919 ms | 0.889 (0.846–0.927) |
| `wc -l /wiki/*/*.md \| tail -1` | 1,344 ms | 1,243 ms | 0.929 (0.866–0.999) |
| `grep -rc owner /wiki \| tail -1` | 1,456 ms | 1,454 ms | 0.971 (0.905–1.019) |
| `cat /wiki/sales/*.md \| grep -c owner` | 204 ms | 187 ms | 0.955 (0.774–1.146) |

Every pair printed the same output.

## Rejected

Collecting short writes in the pipe and handing them over on the reader's
next read (`rejected-pipe-coalescing-2026-10-31.ts.txt`) halved the
microbenchmark further, to 8.1 µs, but doubled `wc -l glob | tail -1`
(1.3 s to 2.8 s): with no high-water mark the stream calls back into the pipe
for every read, which costs more on Workers than the writes it saves.

## What remains

`awiki`'s parse is ordinary JavaScript, about four times slower than locally,
and its first run also pays the SQLite page reads of every body. `awk` still
builds a string and a field list per record. A line written per call to a
pipe still costs about 10 µs plus the reader's work for it.

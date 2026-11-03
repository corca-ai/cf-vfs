# cut, uniq and nl without an await per line, 2026-11-03

Goal: make `cut`, `uniq` and `nl` as cheap per line as `grep` and `awk`,
which take a bulk body's lines synchronously and a stream's a chunk at a
time (#132, #133, #138). These three iterated `readTextLines` with
`for await` and awaited each write, so even a bulk body cost an await or two
per line. Measured locally only: the SQL lab on local workerd and the full
local suite. No Cloudflare usage.

## Change (`src/shell/commands/text.ts`)

`cut`, `uniq` and `nl` visit lines with `eachLine(textLines(...))` and write
with `BufferedTextWriter.put`, which returns a promise only when the buffer
must reach its sink; `continuing` turns that into the visitor's answer.
`fold`, which writes several pieces per line, and `xargs`, which reads only
stdin, keep `readTextLines`.

## Results

Local workerd, main (5fd9150) bundled beside this branch, both warmed, ten
alternating pairs over the 10,000-page S3 wiki (`local-workerd-pairs.jsonl`),
outputs identical in every pair:

| Command | before | after | ratio (95% bootstrap) |
| --- | ---: | ---: | ---: |
| `cut -c1-8 /wiki/*/*.md \| wc -l` | 459 ms | 358 ms | 0.814 (0.770–0.897) |
| `cut -d: -f1 /wiki/sales/*.md \| wc -l` | 44 ms | 33 ms | 0.766 (0.741–0.791) |
| `uniq /wiki/*/*.md \| wc -l`¹ | 161 ms | 136 ms | 0.823 (0.771–0.853) |
| `uniq -c /wiki/legal/*.md \| tail -1` | 67 ms | 54 ms | 0.805 (0.795–0.814) |
| `nl /wiki/sales/*.md \| tail -1` | 42 ms | 30 ms | 0.725 (0.711–0.738) |
| `cat /wiki/sales/*.md \| cut -c1-8 \| wc -l` | 53 ms | 47 ms | 0.895 (0.881–0.909) |
| `cat /wiki/sales/*.md \| uniq \| wc -l` | 75 ms | 63 ms | 0.847 (0.834–0.862) |
| `cat /wiki/sales/*.md \| nl \| tail -1` | 38 ms | 32 ms | 0.837 (0.823–0.850) |
| geometric mean | | | 0.812 |

¹ Exits 1 in both versions: the whole wiki through `uniq` exceeds the
8 MiB pipeline-edge limit, which both reach at the same point.

Full local suite on the code as committed (`bench:local:paired`,
`local-group-v1`, full plan, four sessions with `ORDER_OFFSET` 0, 1, 0, 1;
`local-paired-s1..4.json`, `../summarize-local-pairs.mjs`): overall 1.000,
families 0.991–1.018; SQL statements 2,097,231 → 2,097,235, rows read
2,096,836 → 2,096,819. Six workloads measured above 5%, all in the coding
families' Git steps (`git status`, `add`, `commit`, `diff`), which run no
`cut`, `uniq` or `nl`. Twelve pairs in two sessions over their three groups
(`local-paired-recheck-o0/1.json`): overall 1.006; the six measured
0.946–1.033, and four other Git steps rose above 5% (1.051–1.077).

## Reviews

Two independent reviews. One compared main with this change over 341
scenarios: host stdin in 1-byte, empty and split-character chunks, invalid
UTF-8, the line and record limits, `maxStdoutBytes`, aborts, `| head`,
missing and directory operands, `uniq` groups across files, `nl` numbering
across files. Output, status, stderr and the chunk and reason the upstream
stream was cancelled with were identical; only how much a 1–16 ms deadline
lets through differed, as the code is faster. It found `uniq` building each
line before it moves on safe, since `eachLine` awaits the write before the
next line. The other found the bundle budgets exceeded, no CHANGELOG entry,
and a test that would not catch a visitor stopping after the first flush:
`test/line-utilities-bulk.test.ts` now writes past the writer's 64 KiB
buffer and checks the whole output, and fails with that fault injected.

## Behaviour that differs

Concurrent pipeline stages can interleave differently, as with #132–#138.

## Bundle size

Two presets went over their budgets and were raised to their measured size
rounded up to 128 bytes: default-registry 648,192 (+128), linux-profile
859,776 (+128).

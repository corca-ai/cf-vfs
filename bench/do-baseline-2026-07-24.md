# Durable Object benchmark baseline — 2026-07-24

Environment: Apple M2, macOS 27.0, arm64, Node v24.6.0, workerd through
`@cloudflare/vitest-pool-workers`. Run with `npm run bench:do`. These are local
operation timings, not production latency predictions.

Latency rows below are medians from three independent benchmark processes.
Each process performs two warm-ups and then amortizes repeated operations.
Setup such as constructing the source subtree is outside the measured window.
The “before” column runs the same benchmark body against pre-optimization
commit `0558e31594df`.

| Durable Object operation | scale | before ms | current ms | speedup |
| --- | ---: | ---: | ---: | ---: |
| tail append | 1 MiB | 1.60 | 1.50 | 1.1× |
| tail append | 8 MiB | 37.25 | 2.00 | 18.6× |
| subtree copy | 100 files | 6.65 | 0.60 | 11.1× |
| subtree move | 100 files | 2.25 | 0.40 | 5.6× |
| subtree remove | 100 files | 4.40 | 0.40 | 11.0× |
| subtree copy | 1,000 files | 73.10 | 4.40 | 16.6× |
| subtree move | 1,000 files | 22.40 | 4.00 | 5.6× |
| subtree remove | 1,000 files | 43.80 | 3.00 | 14.6× |
| warm schema initialization | populated database | 0.017 | 0.008 | 2.1× |
| `stat()` | populated 1,000-file database | 0.0094 | 0.0094 | 1.0× |
| 8-byte overwrite | populated 1,000-file database | 0.145 | 0.105 | 1.4× |
| filtered `findPage()` | 1,000 files | 4.70 | 3.56 | 1.3× |

The current structural ceilings are more reliable regression guards than
wall-clock values:

| Operation | Current measured work |
| --- | --- |
| 1 MiB overwrite plus snapshot | 31 rows read, 11 rows written |
| `stat()` in a populated namespace | 1 statement, 2 rows read, fully consumed cursor |
| 8-byte overwrite | 13 statements, 19 rows read, 5 rows written |
| 1 MiB / 8 MiB tail append | at most 4 rows written |
| subtree copy / move / remove | 11 / 7 / 10 statements at both tested sizes |

The benchmark fails if those structural costs increase. The separately
scheduled Performance workflow runs `npm run bench:check` weekly; it can also
be launched manually. Update this baseline only after investigating a guard
failure and confirming that the new work is intentional.

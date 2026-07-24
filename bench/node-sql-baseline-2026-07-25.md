# Node in-memory SQLite benchmark baseline — 2026-07-25

Environment: Apple M2, macOS 27.0, arm64, Node v24.6.0. Run with
`npm run bench`. Each scenario performs one warm-up followed by the median of
three observations. A fresh `DatabaseSync(":memory:")`, schema initialization,
and VFS setup are inside each observation; database close is outside the timed
window. These values are local regression evidence, not production latency
predictions. The executable check applies a deliberately broad 10-second
per-scenario ceiling.

| Node in-memory SQLite scenario | median ms | peak heap Δ | peak ArrayBuffer Δ | peak RSS Δ | output bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| inline 1 KiB | 1.342 | 565,584 | 270,381 | 229,376 | 1,024 |
| inline 64 KiB | 1.878 | 78,544 | 786,477 | 901,120 | 65,536 |
| inline 1 MiB | 2.691 | 94,960 | 8,650,797 | 9,207,808 | 1,048,576 |
| inline 8 MiB | 14.396 | 0 | 0 | 22,495,232 | 8,388,608 |
| inline overwrite 1 MiB | 2.902 | 128,856 | 11,010,129 | 262,144 | 1,048,576 |
| pipeline 1 stage | 13.370 | 308,584 | 3,145,728 | 622,592 | 8 |
| pipeline 3 stages | 14.267 | 2,546,640 | 3,145,728 | 4,210,688 | 8 |
| pipeline 6 stages | 14.656 | 859,280 | 5,242,880 | 131,072 | 8 |
| 16,384 one-byte chunks | 267.503 | 29,585,160 | 0 | 46,809,088 | 6 |
| 1 MiB line through sort | 5.285 | 3,356,480 | 8,388,633 | 3,211,264 | 1 |
| early cancellation | 1.044 | 260,424 | 36,897 | 49,152 | 1 |
| slow consumer, 64 × 1 ms | 79.275 | 1,011,472 | 786,436 | 835,584 | 262,144 |
| four concurrent shells | 7.905 | 9,498,640 | 1,310,720 | 16,384 | 28 |
| opaque 1 MiB lifecycle + GC | 3.038 | 117,304 | 5,242,984 | 0 | 0 |
| opaque 64-object GC batch | 40.381 | 6,145,776 | 20,981,088 | 1,572,864 | 0 |

A zero observed delta means the operation completed between samples or garbage
collection lowered live memory; it does not mean zero allocation. The early
cancellation source exposed 1 MiB lazily and pulled only 16 KiB.

Opaque lifecycle logical operations and marginal Standard-storage estimates:

| Scenario | Class A | Class B | free delete requests | estimated operation USD |
| --- | ---: | ---: | ---: | ---: |
| one object | 1 | 1 | 1 | 0.00000486 |
| 64-object batch | 64 | 64 | 1 | 0.00031104 |

Node's SQLite API does not report Cloudflare `rowsRead` or `rowsWritten`, so the
executable rows leave those fields `null`. The workerd and deployed benchmarks
remain authoritative for platform query plans, billed row work, database size,
RPC latency, alarms, and output-gate behavior.

See [performance interpretation](../docs/performance.md) for exclusions and
current pricing links.

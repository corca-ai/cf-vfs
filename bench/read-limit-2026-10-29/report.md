# Separate file read limit: local regression screen

Commit `43b6e77` routes every chunk a command consumes through a `WeakSet`
lookup that decides whether it counts against `maxReadBytes` or
`maxTotalIoBytes`, on the same read path the public workloads use. It is not a
performance change; this screen checks that it costs nothing measurable.

Baseline `5453f8a`, candidate `43b6e77`, compiled with
`bench/agent-task-2026-10-12/compile.mjs`, run with `bench:local:paired`
(`local-group-v1`, `FIXED_GIT_TIME=1`, `CREDENTIALS=demo`, six pairs) and
summarized with `../regex-prefix-2026-10-29/local/summarize-local.py`.

| Run | Overall geometric mean, candidate / baseline |
| --- | --- |
| AB 1 (`ORDER_OFFSET=0`) | 1.0060 |
| AB 2 (`ORDER_OFFSET=1`) | 1.0038 |
| AB 3 (`ORDER_OFFSET=0`) | 0.9966 |
| AB 4 (`ORDER_OFFSET=1`) | 0.9981 |
| A/A | 0.9987 |

Mean 1.0011, standard deviation 0.0045 across sessions. One workload pooled
above 5%, `coding-mixed status-final` at 100 files (1.066; sessions 1.181,
1.006, 0.985, 1.105). Twelve alternating pairs in two sessions gave 1.021 and
1.011 on a 2.3 ms median, so the slowdown did not reproduce. No Cloudflare
run was made: the change is not offered as a speedup, and the local screen
found nothing to escalate.

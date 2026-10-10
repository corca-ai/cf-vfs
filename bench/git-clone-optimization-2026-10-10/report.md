# Local Git transfer metadata reuse — 2026-10-10

The transfer walker used `readdir` and then `lstat` for every object even though
VFS directory listings already contain entry metadata. It now retains that
metadata for the current directory. Clone, fetch, pull and push share this walker.
There is no new public filesystem API and no cache across commands.

Object bytes still use the existing scoped Git adapter. Read/write permissions,
I/O and mutation limits, quota handling, umask, destination existence checks,
object-store symlink rejection and per-entry cancellation checks remain in place.
Hosts must serialize repository operations and edits, as already required.

## Local comparison

Node v24.18.0, real SQLite filesystem, 1,000 deterministic 768-byte files and two
committed generations with all bodies changed without shrinking. Three warmups
and ten alternating baseline/candidate pairs; instrumentation disabled for timing.
The baseline is the deployed implementation preceding this change, including
the previous checkout lock fix.

- Median clone: 222.93 → 209.65 ms.
- Median paired candidate/baseline ratio: 0.9376.
- Paired bootstrap 95% interval: [0.9215, 0.9813].
- A separate instrumented clone: 48,439 → 46,177 SQL statements (-2,262, -4.67%).
- File body reads: 3,067 → 3,067. Counters stop before post-clone verification.

See `local.json`, `local-sql.json` and `compare.mjs`. Instrumented times are not
used as timing evidence. The smaller initial exploratory run was superseded by
these final-source measurements.

## Validation

The full check includes Node tests, Workers tests, POSIX conformance, type checks,
lint, quality, package, documentation, benchmark protocol and twelve tree-shaking
budgets. A new clone regression checks that directory metadata cannot authorize
reading an object without POSIX read permission. Existing transfer tests cover
history, branches, tags, binary bytes, modes, symlinks, scoped roots and refusal
of object-store symlinks. Git remains an optional applet.

## Cloudflare evaluation

Production is deployed at https://vfs.borca.ai/ with a newly requested benchmark
at https://vfs.borca.ai/benchmarks/. Results and source verification are stored
alongside this report after completion.

`cf-before.json` uses the unchanged authenticated evaluation Worker and isolated
32 MiB repositories; `cf-after.json` collects separate SQL profiles after that
Worker is updated. `cf.mjs` measures external client wall time only. CPU phase
clocks inside Durable Objects are not used. Fixture preparation and inspection
are outside clone timing. Each measured clone starts with a recreated source and
empty destination. The retained profile runs record room names and cleanup outcomes in their JSON.
An earlier exploratory wall-time run lost its in-memory results when a cleanup
request hit a network connection timeout; those timings are excluded. Its room
cleanup could not be confirmed. The harness now persists results before cleanup.

Private client wall time and public Worker-to-DO RPC time are different metrics.
Public comparisons are descriptive: three samples plus a warmup per workload,
with substantial Cloudflare variance. Local paired timing and separate SQL work
counts establish the retained optimization; one public median does not establish
a stable Cloudflare latency gain or regression.

## Completed production result

- Deployment: `9ba80ff8-5b61-42cb-8870-2643d00996a5`.
- Build: `408a854e33236e999086644c31547edfc717389024d4158eb54a67f258a33229`.
- Run: `2341c239-1cdf-4426-a45f-d4a0e087ab7c`; 190 rows, 60,648 assertions.
- Source fingerprint verified across 207 runtime files; result build/deployment
  match current source. Repeated request reused the same VFS result and mtime
  with the existing 600,000 ms TTL.

Actual Cloudflare separate SQL profiles, 1,000 files / two generations, both
small and mixed workloads:

| Counter | Before | After | Change |
|---|---:|---:|---:|
| SQL statements | 41,927 | 39,665 | -2,262 (-5.40%) |
| Rows read | 84,163 | 81,901 | -2,262 |
| Rows written | 19,682 | 19,682 | unchanged |

The saved profile-run rooms were all successfully cleared. Their instrumented
client wall times are not used for speed conclusions.

Public Worker-to-DO RPC clone timing, 1,000 files, one warmup and three samples:

| Workload | Previous median | New median | New samples |
|---|---:|---:|---|
| Small | 4,258 ms | 5,116 ms | 5,352 / 5,116 / 4,442 ms |
| Mixed | 5,566 ms | 4,488 ms | 4,226 / 4,994 / 4,488 ms |

The opposing movements do **not** demonstrate a consistent Cloudflare latency
improvement. The change is retained for a repeatable local paired improvement
and a directly confirmed reduction in production-runtime SQL work. No claim is
made that the slower small-file median is a proven code regression or that the
faster mixed median is a stable speedup. Baseline public data remains in
`../coding-durability-2026-10-10/public-cf-after.json`.

Final validation: `npm run check` passed (1,923 Node tests, 155 Workers tests,
46/46 POSIX comparisons and all remaining checks). The optional Git bundle is
549,506 / 563,968 bytes, +310 bytes; all other eleven preset sizes are unchanged.
The runtime/library source is unchanged since that validation and deployment.

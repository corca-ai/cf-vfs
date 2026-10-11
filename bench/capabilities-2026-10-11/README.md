# Capability evaluation evidence

See [the evaluation report](../capability-extensions-2026-10-11.md) for the
decision and interpretation. Latency ratios are candidate / baseline; below
one is faster. Native Cloudflare row counts are distinct from Node returned rows.

- `graphs.json`, `source-fingerprint.json`, `compiled-graphs.json.gz`: final
  immutable source identity and lossless compiled baseline/candidate modules.
- `local-unicode-{demo,none}.json.gz`: final ten-pair full local comparisons.
- `cf-unicode-{demo,none}.json[.gz]`: final ten-pair full CF comparisons. A file
  without `completedAt` is incomplete and must not be used as adoption evidence.
- `local.json`: isolated 20-pair focused metadata and incremental-refresh probes.
- `cf-native.json`: ten alternating-order native SQLite cost probes.
- `cf-setup-costs.json`: ten initial-index and feed-on/off overwrite cost probes.
- `cf-query-shapes.json`: rejected query shapes, including the metered JSON
  relation and unconstrained join. `query-shapes-worker.ts.gz` retains the probe.
- `verification.json`: correctness and unchanged bundle-budget check outputs.
- `public-baseline.json.gz`, `public-candidate.json.gz`: three-sample descriptive public
  page runs, collected separately from the controlled paired evaluation.
- `public-smoke*.json`: actual public shell Git/document-overlay/clone/DAC smoke.
- `preliminary*`, `pre-unicode*`, `full-*`: superseded experiments, retained for
  audit. These are not final evidence. Gzip archives preserve the original JSON.

The full drivers are `../three-hour-2026-10-10/{local,remote}-pairs.mjs`.
Both use a fixed Git identity time and alternate baseline/candidate order. The
local driver uses `STAGE_ORDER=1 FIXED_GIT_TIME=1 PAIRS=10 WARMUPS=1` with the
two graph directories. The remote driver uses `COLOCATED=1 PAIRS=10 WARMUPS=1`,
the expected `CANDIDATE` build and private `EVALUATION_URL`; each credential mode
has its own room. Timing and SQL profiling are separate passes. All 146 uncached
workloads define the primary geometric mean; 44 cache workloads are separate.
Full local timing runs were serialized and isolated from local test runs.

To recreate graphs, use `compile.mjs SOURCE_DIRECTORY OUTPUT_DIRECTORY` on the
baseline commit and candidate source. The private Worker imports point to
`../three-hour-2026-10-10/compiled/capabilities-{baseline,candidate}/`; that
generated directory is intentionally ignored. Restore the archived JavaScript
modules there or copy recreated graphs. The graphs archive maps relative paths
to module text under `baseline` and `candidate`; compare its hashes to graphs.json.
Use the repository's pinned toolchain and lockfile.

Private Worker configs require `EVALUATION_TOKEN`; no credential is archived.
Set an account and private secret when reproducing, deploy with the matching
config and wait for the expected build before measuring. Evaluation Workers
and their rooms are removed after this experiment. The public smoke creates
only its unique temporary directory in the shared country workspace and removes
it on completion.

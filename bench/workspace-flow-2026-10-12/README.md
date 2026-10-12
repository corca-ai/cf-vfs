# Workspace traversal and commit publication, 2026-10-12

Baseline: `4be925c4c5e76f4c066407150740d0fd9e72c166`.

This experiment follows a non-interactive coding task through inspection,
editing 20 of 1,000 files, validation, whole-repository staging and commit.
The ordinary Git applet is used; change recording and the optional tracked
Git applet are disabled in both arms. UID/GID 1000 and root mode 0777 match.
Author time is fixed. Separate shell executions share a single VFS owner.
Each measured cycle creates distinct content and Git objects. Every command
must succeed; validation output and matching commit output are checked.

## Reproduction

Restore compiled graphs (JavaScript SHA-256 verified) into a new directory:
`baseline` is the original source, `candidate` the traversal-only change, and
`combined` the final traversal and lazy commit-publication implementation,
including per-path bulk-view fallback. `preBoundary` preserves the intermediate
implementation measured before that compatibility correction.

```sh
node bench/workspace-flow-2026-10-12/restore.mjs /tmp/workspace-replay
PAIRS=30 node bench/workspace-flow-2026-10-12/local.mjs \
  /tmp/workspace-replay/baseline /tmp/workspace-replay/combined /tmp/flow.json
PROFILE=1 PAIRS=3 node bench/workspace-flow-2026-10-12/local.mjs \
  /tmp/workspace-replay/baseline /tmp/workspace-replay/combined /tmp/costs.json
FIXED_GIT_TIME=1 CREDENTIALS=demo PAIRS=10 WARMUPS=1 \
  node bench/three-hour-2026-10-10/local-pairs.mjs \
  /tmp/workspace-replay/baseline /tmp/workspace-replay/combined /tmp/full.json
```

The final local task run has 2 warmup cycles and 30 alternating pairs.
Timing disables the SQL observer; a separate run records SQL diagnostics.
Node returned rows are not billed Cloudflare rows. The local full suite
separates unobserved timing and SQL profiling and preserves all 190 existing workloads.
Its 146 uncached workloads retain their equal-weight geometric mean; 44
metadata-cache variants are reported separately.

For a private Cloudflare replay, link those graphs at the ignored
`bench/three-hour-2026-10-10/compiled/workspace-before` and `workspace-after`
paths. `worker.ts` and `wrangler.jsonc` define the evaluator. Supply the private
`EVALUATION_TOKEN` using Wrangler's secrets mechanism; credentials are not
included in this archive. Override `EVALUATION_URL` when using a different
Worker. `remote-flow.mjs` verifies Worker and DO build identities and compares
20 alternating pairs, reconstructing each arm on the same DO. Both arms run
2 untimed complete cycles before measurement. Phase wall times are measured
in the Worker around DO RPC, not in the client and not with a zero-resolution
DO clock. Timed task phases include SQL metering in both arms. Preparation is
excluded; this task experiment does not establish cold workspace performance.
Full-suite prepare/clone workloads provide separate cold controls.
CF full-suite timing also retains the same SQL meter in both arms; its separate
profile pass supplies the reported cost counters. It is not uninstrumented
production latency. The post-deployment public run provides an additional
production-build check.

`remote-full.mjs` accepts `CANDIDATE`, `EVALUATION_URL`, `COLOCATED=1`,
`CREDENTIALS=demo` (omit for unbound), `PAIRS=10`, and `WARMUPS=1`.
`BENCH_GROUPS` selects repeat groups; selected repeats are not full-suite scores.
The final comparison additionally sets `GROUP_PAIRS=1`: each complete group
gets a fresh fixture for each arm, and the versions run consecutively before
moving to the next group. This reduces temporal separation without changing
workload identities, validation, weights or alternating pair order.

## Evidence conventions

- `baseline.json`: initial identical-code diagnostic; only 3 pairs, not a
  statistical unchanged-code performance control.
- `write-retention.json`: initial write-only prototype.
- `workspace-retention.json`: expanded prototype using repeated old/new bodies;
  includes local SQL observation in timing, unlike final local evidence.
- `cf-repeated-content-preliminary.json`: interrupted CF diagnostic using two
  alternating file contents; excluded from adoption evidence.
- `local-flow-final.json` / `local-flow-costs.json`: final distinct-content task,
  separate trace-free timing and SQL diagnostics.
- `cf-flow.json`: distinct-content actual CF task.
- `full-local-*.json` / `full-cf-*.json`: complete regression controls.

Large completed JSON/logs may be stored as lossless `.gz` archives. Confidence
intervals use deterministic paired bootstrap in `bench/comparison.mjs`.
Ratios are candidate/baseline latency; below 1 is faster. Preparation and
postcondition checks are outside measured task phases. No FS API, persisted
schema, dependency, or bundle-budget allowance is added.

`local-commit-prototype*.json` and `commit-buffer-prototype.patch` are an
additional exploratory experiment, comparing delayed commit object publication
against the traversal candidate. It did not establish a local whole-task
latency improvement. A subsequent local Workers cost probe found fewer writes
with more reads and motivated a separate CF experiment. Its small static reservation
was a prototype parameter, not a new production policy.

`differential.mjs` / `differential.json` compare 4,000 seeded operation sequences
against the baseline, including complete namespace metadata after every step.
The 13 operations cover writes/batches, append, file/directory removal, mkdir,
chmod/chown, symlinks, move/copy, token reads, stat and byte reads. Three
principals share each owner. Deterministic clocks and IDs permit exact comparison
of results, errors, tokens and metadata. 1,741 operations succeeded; all 4,000
outcomes and namespace comparisons matched. This complements the native POSIX
oracle; it is not an independent POSIX specification.


`commit-worker.ts` / `wrangler.commit.jsonc` compare the traversal candidate
against that same graph with the commit-buffer prototype patch. They use separate
`CommitEvaluation` objects. `workerd-commit-costs.json` has 20 paired local
Workers samples with timing summaries disabled (`COST_ONLY=1`); clock-zero
samples are not changed to artificial positive values. The initial local
dev-server reload interrupted a preliminary run, preserved under
`workerd-commit-reload-interrupted.json`. Set `CANDIDATE=commit-buffer-prototype`
when using `remote-flow.mjs` for this separate evaluator.

`cf-commit-prototype.json` is the completed 20-pair CF prototype comparison.
The first CF attempt stopped after one recorded pair. Cleanup returned a CF
internal-error response and masked the initiating failure;
`cf-commit-internal-error-incomplete.json` and its log are excluded from adoption
evidence. The runner now preserves the original failure if cleanup also fails.
Private fixtures are cleared and their Workers deleted after evaluation.

`final-worker.ts` / `wrangler.final.jsonc` compare the original baseline against
`combined`, linked at the ignored `compiled/workspace-compatible` path. This reuses
the commit evaluator's private Worker after its prototype run has finished;
the expected build is `workspace-flow-compatible`. `cf-combined-flow.json` and
`full-cf-combined-*.json` are the final CF evidence. `local-combined-*` and
`full-local-combined-*` are the corresponding local evidence. The
`local-commit-lazy-preliminary*` files precede a helper refactor and are retained
only as preliminary measurements. `combined-source-fingerprint.json`,
`combined-release-equivalence.json`, and the archived graphs identify the final
measured implementation; their unprefixed counterparts identify the earlier
traversal-only candidate.

`pre-boundary-*` files and the `preBoundary` graph preserve the intermediate
combined implementation. `pre-boundary-worker.ts.txt` preserves its exact Worker
source (build `workspace-flow-final`, candidate link `compiled/workspace-final`).
Its unbound full CF run was intentionally stopped after a compatibility case
was found: a view can expose `writeFiles` yet refuse bulk replacement for a path.
Two failing tests demonstrate false/absent eligibility before the correction;
the final writer selects individual writes for such sets. Complete local and
CF comparisons are restarted against the original baseline for the corrected
source. The incomplete run is not used for an adoption conclusion.

`cf-readdir-recheck.json` repeats the traversal-only 1,000-file uncached file
group: the initial readdir timing flag was not reproduced. Ten timing flags in
the traversal-only unbound control are retained, and all 190 workloads are
reassessed in the final group-paired controls instead of claiming those earlier
flags were disproved by the aggregate. Node unbound combined cost flags include
additional returned rows at commit publication; actual CF reads and writes
are reported separately, since batching can trade more reads for fewer writes.


Final adoption and public verification are in the linked report. The two final
full CF summaries and `cf-final-rechecks-summary.json` retain aggregate results,
all initial regression flags and their independent repeats. `public-after.json`
and `public-repeat.json` retain both production screens; their assessments and
`public-flag-review.json` retain unresolved per-workload variation. The public
history has one point for source commit `4e449bb` after both executions.
`private-cleanup.json` records fixture cleanup and deletion of both evaluators.

# Bash word expansion experiment — 2026-10-11

Baseline is production source `ea1b5dc` (checkout HEAD `5ba007f`).
`graphs.json` identifies complete compiled baseline and candidate module graphs;
`compiled-graphs.json.gz` stores those immutable JS graphs for reproduction;
`compiled-types.json.gz` retains their declarations for private Worker typechecks.
No new filesystem APIs or persistent shell/parser caches are involved.

`scenarios.ts` fixes five shell workloads before final Cloudflare evaluation:
ordinary arguments, long literals, quoted/parameter words, function/arithmetic
loops, and real brace expansion. Default execution budgets apply. All executions
verify stdout, empty stderr and success. `local.mjs` takes three warmup pairs
and twenty alternating measured pairs; it includes parsing and execution.
`remote.mjs` uses the same scripts, twenty executions per RPC, twenty alternating
pairs after three warmup pairs on one DO. Caller-side RPC wall time divided by
twenty includes RPC overhead and is not an isolated CPU-time measurement.

Run local comparisons with:

```sh
node bench/bash-2026-10-11/local.mjs BASELINE_GRAPH_ROOT CANDIDATE_GRAPH_ROOT output.json
node bench/bash-2026-10-11/oracle.mjs CANDIDATE_GRAPH_ROOT /path/to/bash
```

The extra oracle evidence uses installed Bash 5.3.20, LC_ALL=C, TZ=UTC.
Docker is unavailable, so the existing pinned Bash 5.3.3 fixture set is left
unchanged and runs as part of the ordinary test suite.

`summarize-shell.mjs` computes the shell aggregate confidence intervals by
resampling matched pairs within each workload and recomputing the unchanged
geometric mean of workload medians.

The private Worker uses the existing authenticated evaluation protocol and
separate UUID rooms. It is not a public endpoint and should be removed after
measurement. It was deleted after the final measurements, and temporary
compiled directories were removed. Its compiled imports live in the existing ignored
`bench/three-hour-2026-10-10/compiled/bash-{baseline,candidate}` directories;
restore the archived graphs there before redeployment. Generate bindings with
Wrangler and check `tsconfig.json` in this directory. Never commit `.dev.vars`.

Existing 190-workload FS/Git comparisons use the established drivers:

```sh
PAIRS=10 WARMUPS=1 FIXED_GIT_TIME=1 STAGE_ORDER=1 CREDENTIALS=demo \
  node bench/three-hour-2026-10-10/local-pairs.mjs BASELINE CANDIDATE output.json
PAIRS=10 WARMUPS=1 COLOCATED=1 CREDENTIALS=demo \
  CANDIDATE=bash-e1d5e34f4825b460 EVALUATION_URL=PRIVATE_WORKER_URL \
  node bench/three-hour-2026-10-10/remote-pairs.mjs output.json
```

The shell score is a separate five-workload geometric mean. It does not change
the weights, membership, or history of the existing FS/Git overall score.
All raw pairs, flags and SQL increases are retained; a one-run public comparison
is descriptive, not a substitute for controlled alternating pairs.

`cf-preliminary.json` used the earlier candidate before the crossing-backslash
compatibility fix and overlapped a private harness redeployment. It is retained
as exploratory evidence and is not the final adoption measurement.

`profile.mjs` runs 150 verified long-literal loops against one graph. The two
compressed `.cpuprofile` files and `cpu-profile-summary.json` are explanatory
CPU samples, including startup, rather than another latency comparison. They
show the ordinary-word brace allocation path disappearing from the hot stack.
The paired shell measurements remain the latency evidence.

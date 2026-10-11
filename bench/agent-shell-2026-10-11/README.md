# Non-interactive agent shell evaluation

Baseline: `180702f` (runtime source `3c7e044`). Node 24.18.0, macOS arm64.
Only `src/core/json-value.js` differs in the final 200-module library graph.
Graph fingerprints and exact executable/type archives are retained.

Restore into a **new** directory, then replay the ten agent workflows:

```sh
node bench/agent-shell-2026-10-11/restore.mjs /tmp/agent-replay
node bench/agent-shell-2026-10-11/local.mjs /tmp/agent-replay/baseline /tmp/agent-replay/candidate /tmp/agent-local.json
node bench/agent-shell-2026-10-11/oracle.mjs
```

`oracle.mjs` expects `/opt/homebrew/bin/bash`; its saved result records the host
versions. It checks stdout/status and exact edited files. Numeric command
padding is normalized only for native `uniq`/`wc`; benchmark output is exact.

The default local driver uses ten warmup pairs, twenty alternating measured
pairs, ten independently parsed/executed scripts per sample. File setup is
outside timing; output and rewritten file checks are outside local timing.
No parser/filter cache or cross-execution session is introduced.

The private authenticated Worker uses the same Durable Object for alternating
versions, UID/GID 1000, default shell limits, fifty script executions per RPC,
three warmup pairs and twenty measured pairs. Timing is caller Worker RPC wall
time divided by fifty, including constructor/validation overhead; it is not
isolated CPU time or browser/network roundtrip latency. File validation runs
in a separate RPC after each workload. Native SQL counters must match both
versions in every measured sample. Never archive the evaluation token.

To recreate the private Worker, point its two compiled import roots in
`bench/three-hour-2026-10-10/compiled/` at restored graphs: `agent-baseline`
points to restored `baseline`, and `agent-spans` points to restored `candidate`. The archived intermediate `parserAndCheck` graph is needed only to
reproduce the preliminary eight-workload run. Generate bindings with Wrangler,
typecheck this folder's tsconfig, and deploy with a private secrets file.
The private Worker is deleted after evaluation; it is not a public product API.

Existing complete 190-workload controls use the previously retained
`bench/three-hour-2026-10-10/{local,remote}-pairs.mjs` drivers with ten pairs,
one warmup and fixed Git author time. The 146 uncached and 44 cache rows stay
separate. Their timing, cost screens and any follow-up evidence remain in the
report, including unsuccessful and preliminary measurements.

`cost-replay.mjs` repeats the complete 100-file Git shell group with fixed VFS
and Git identity clocks for both demo credentials and the unbound adapter.
It preserves differences instead of declaring every cost equal. Same-build
A/A replays investigate existing timing-sensitive batching variability;
Node returned rows are not Cloudflare billed rows.

`plan-{5,8,10}.json.gz` preserves each workload cohort and its fixtures. The
preliminary CF result uses eight cases and ten repetitions per RPC; the first
final span candidate uses eight cases and fifty repetitions. A post-deploy
propagation attempt was rejected by the build guard before measurements; it
was not included in any result. The following successful run verified the
expected identity for every response.

The complete local libraries differ in exactly one JS module. SQL trace replay
shows clone cost changes of one bounded write transaction in either direction,
including BEGIN/COMMIT, usage accounting and parent timestamp publication.
The unchanged timer-based checkout batching is the source of this variability;
fixing the VFS clock does not fix the event-loop scheduling. The raw full-suite
cost flags remain visible rather than being overwritten by the follow-up.

Final target results are `local-ten.json`, `cf-ten.json`, and
`agent-summary.json` (ten workloads). `local-final-idle.json`, `cf.json` and
`shell-summary.json` preserve the earlier eight-workload comparison; its tiny
command slowdown was not reproduced by the ten-workload twenty-pair follow-up.
`full-cf-demo.json.gz` is the complete 190-workload control with ten pairs and
native SQL counters. It retains the overall +1.4% timing result and eight
initial confirmed flags. Follow-up group comparisons must not replace that
full-suite aggregate. The archived full-suite timing includes the SQL meter on
both implementations; the public deployment check uses its ordinary timing path.

Final regression evidence includes two independent complete-group repeats,
`pooled-followups.json`, the byte-identical A/A control (`cf-cache-aa.json`),
and the reversed-import comparison (`cf-cache-swapped.json`). In the latter,
raw candidate/baseline means old/new. `crossover.mjs` documents its conditional
slot-effect assumption; its diagnostic does not replace the full-suite score.

`public-verification.json` preserves all descriptive public regression flags
and deployment identity; `public-candidate.json.gz` retains the complete state.
The production Bash workflow evidence is `public-smoke.json`; rerun it with
`node bench/agent-shell-2026-10-11/public-smoke.mjs public-smoke.json`
(the output argument is relative to the script directory).

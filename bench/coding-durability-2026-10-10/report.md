# Coding durability and remaining Git latency — 2026-10-10

Completed actual CF and local evaluation. The authenticated evaluation Worker
uses a separate Durable Object namespace from the public country workspaces.

## Verified defect and retained fix

The engine's module-level index mutex uses only a pathname as its key. A checkout
stalled while holding that mutex prevents an independent filesystem's same-path
checkout from finishing. `isolation-before.log` records the failing regression;
`isolation-after.log` records the passing result. Actual DO reset during checkout
also prevented subsequent index inspection in the baseline local/CF probe.

Checkout now uses a unique engine-only gitdir alias, translated back to real VFS
paths in a private adapter. No namespace entry or new FS API is introduced. Host
serialization of repository commands and edits remains required. Local workerd
now completes the actual reset, inspects history/index and repairs through
`git checkout --force base`. Clone and pull checkout use the same helper.

This experiment does not establish crash recovery for every Git command. In
particular, a reset during add, commit or ref publication is not covered by the
checkout-specific fix. It does not provide whole-command atomicity.

## Editor durability boundary

A version acknowledgment confirms an in-memory edit, not durable publication.
Real quota failure keeps the pending text and reports a save error. Restarting
that object loses the pending text while preserving the previously published
file. This is an observed limitation, not a successful pending-edit recovery.
The current implementation has no durable draft journal. Do not interpret
socket reconnect or a retained in-memory document as restart durability.

## Reproduction

- `run.mjs`: default localhost:8798, `EVALUATION_URL` selects the authenticated CF
  evaluation Worker. `RELIABILITY_ONLY=1` skips timings; `SKIP_RELIABILITY=1` skips
  faults; `EVALUATION_OUTPUT=FILE.json` selects an artifact. `EVALUATION_TRACE=1`
  emits stage progress without credentials.
- `worker.ts` imports the actual VFS, Git applet, DemoDocuments and
  WorkspaceOperations. It is an isolated host, not the public demo DO. Timing
  rooms use native storage; separate `-profile` rooms instrument SQL. The quota
  fault control is persisted because object eviction can discard memory.
- Timings use 1,000 deterministic 768-byte files; mixed profiles replace four
  with 256 KiB bodies. Every tracked file is changed without shrinking it. One
  warmup and five measured rounds per profile. Setup and full committed-blob
  verification occur outside the measured execution phase.
- `probe-workspace.mjs` exercises the actual public shell over WebSockets.
  Queue cancellation probes hold the first command for five seconds to avoid
  mistaking a command that already ran during a network round trip for queued
  work. The protocol's `running` message means admitted, not execution started.
- `/clear` deletes only the evaluation run's own isolated storage. Public probes
  remove only their uniquely named `/home/demo/queue-recovery-*` fixture.

Generate evaluation types with Wrangler, then format `env.d.ts`; its own
`tsconfig.json` keeps its generated Cloudflare global environment separate from
library test and public benchmark environments. The root typecheck includes it.

## Public Cloudflare deployment

Final deployment `5e6bb266-fb6e-488c-8095-850768a02bf8`, build `a12c4dba73d3eb7a24a0f6ce4f98b023c6b5cdd3a66ce598d2d3391ec2891f81`, run `ea0252b5-41ae-488c-b682-12bdc710ce5b`. All 190 workloads and 60648 assertions pass. Source verification matches 207 files; repeated requests preserve the VFS result modification time within the 600,000 ms TTL.

Worker-to-DO RPC wall times; three samples, one warmup. The preceding same-day run is included to show variance, not establish a speedup or regression.

| 1,000-file operation | Before median (range), ms | Final median (range), ms |
|---|---:|---:|
| git-shell/add-all | 3041 (2220–4777) | 2882 (2026–3174) |
| git-shell/add-unchanged | 963 (55–1372) | 70 (63–94) |
| git-shell/add-changed | 2564 (2142–2584) | 3047 (2799–3236) |
| coding-small/clone | 4868 (4280–4872) | 4258 (3953–5228) |
| coding-small/checkout-base | 242 (220–1702) | 1947 (275–2705) |
| coding-small/checkout-main | 808 (586–2247) | 852 (798–1384) |
| coding-mixed/clone | 4427 (3426–5884) | 5566 (4118–5942) |
| coding-mixed/checkout-base | 905 (491–2121) | 1696 (1344–1961) |
| coding-mixed/checkout-main | 359 (228–1149) | 2234 (272–2441) |

The final diff medians remain 186/188 ms (small/mixed); staged diff is 21/22 ms. Public WebSocket coordination/recovery checks pass all seven scenarios on the new deployment. The earlier one-second cancellation probe could execute before SIGINT arrived; this was a probe timing error, not evidence that a queued cancellation mutated storage. Its abandoned fixture was removed.

## Actual reset result

The dedicated CF before probe resets during the eighth worktree write. Post-reset index inspection times out after 30,003 ms. After the fix, a different instance inspects the unchanged committed HEAD in 310 ms client wall time, and force checkout plus clean status completes in 523 ms. These individual times demonstrate recovery/liveness, not a general latency speedup. See [restart-before-cf.json](restart-before-cf.json) and [restart-after-cf.json](restart-after-cf.json).

## Timing instrumentation correction

Application-level phase clocks proved unreliable in the deployed DO: CPU-only
operations first returned zero, and timer-barrier variants sometimes reported
execution longer than client request wall time. All `executionMs`, `queueMs` and
`totalMs` values in diagnostic artifacts are excluded from conclusions, including
`cf-reliability-and-diagnostics.json`, `cf-performance-before.json`,
`cf-timing-final.json`, `frozen-clock-summary.json` and `end-barrier-summary.json`.
Cloudflare documents that [production clocks advance only after
I/O](https://developers.cloudflare.com/workers/runtime-apis/performance/).
The final evaluation host removes those phase clocks. The authoritative
latency measurements wrap calls externally; SQL counters are measured separately.
The unchanged public benchmark already wraps DO RPC externally. Client timing
samples from the diagnostic run remain valid, include a 1 ms scheduling barrier,
and are descriptive; no speedup is inferred from that change of measurement.

Queue measurements submit checkout and status together through one RPC into the
actual WorkspaceOperations queue, admitting both before the first executes.
The busy client latency measures time until the queued status finishes; an idle
status control uses the same fixture. Their difference includes preceding
checkout and scheduling, not an exact queue-only timestamp. A pure split between
DO event dispatch, host queue wait and execution was not established on real CF.

## Local checkout control

Node v24.18.0, 1,000 files with one committed edit, three warmups and ten alternating control/fix pairs. The control calls the engine directly with the ordinary gitdir; all other build code is identical. Median 65.126 → 65.117 ms; paired ratio 95% interval 0.9951–1.0205. No meaningful slowdown or speedup is established. Separately instrumented runs execute 6996 → 6996 SQL statements and 2118 → 2118 reads.

Full `npm run check` passes: 1,922 Node tests, 155 workerd tests, POSIX 46/46, types, lint, quality, packaging and all 12 bundle presets. Final targeted types/lint/quality/docs also pass. Git bundle 548,385 → 549,196 bytes (+811), within 563,968; other presets unchanged. [implementation.patch](implementation.patch) isolates the library/test delta from the pre-existing dirty workspace.

## External coding workload and SQL diagnostics

These private fixtures have two complete committed versions of all 1,000 files; clone copies both generations of objects. They differ from the public coding fixture, so compare within a table rather than across fixtures. Five measured client samples follow one warmup; the diagnostic host included a 1 ms scheduling barrier. Instrumented SQL counts are separate from timed samples. No candidate speedup is claimed from these client samples.

| Private workload | Client median (range), ms | SQL statements |
|---|---:|---:|
| small/add-all-changed | 2925.9 (2607.5–4193.2) | 11742 |
| small/commit | 295.9 (268.6–693.5) | 78 |
| small/clone | 4374.1 (3718.9–5276.3) | 41927 |
| small/checkout-base | 2035.3 (1759.5–2122.3) | 12949 |
| small/checkout-main | 1874.9 (1535.6–2903.9) | 12949 |
| mixed/add-all-changed | 2522.3 (2407.8–2897.0) | 11742 |
| mixed/commit | 288.6 (268.1–310.0) | 78 |
| mixed/clone | 3924.0 (3486.4–4133.3) | 41927 |
| mixed/checkout-base | 1949.2 (1786.5–2187.5) | 12949 |
| mixed/checkout-main | 2006.3 (1567.6–3371.8) | 12949 |

## Busy workspace cost

Five paired external observations, one warmup, 1,000 small files with all tracked bytes changed between base/main. Idle status median 638.5 ms; status admitted behind checkout completes in 1700.8 ms. Median within-pair increase 1049.2 ms (range 981.1–1236.9). This is an observed end-to-end blocking effect, not a precise internal queue-wait measurement. It uses the actual queue class in the isolated host, not a 1,000-file public demo room (the demo has a much smaller quota). Evidence: [queue-cf.json](queue-cf.json).

## What to do next

The clearest speed experiment is local clone object copying: it makes 41,927 SQL statements versus 11,742 for changed-all staging. Test batching/reusing existing subtree-copy capabilities while retaining I/O, mutation, permission, cancellation and quota contracts; statement counts alone do not prove a wall-time speedup. Keep the workspace queue until a narrower coordination scheme can preserve aliases, clone source/destination stability and editor correctness.

The remaining reliability priority is durable handling of pending editor text, followed by actual reset tests during add, commit and ref publication. The checkout-specific fix does not establish those guarantees.

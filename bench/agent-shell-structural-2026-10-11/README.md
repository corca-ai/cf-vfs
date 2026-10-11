# Structural agent-workload experiments, 2026-10-11–12

The accepted implementation is the **optional Git command wrapper** in
`src/shell/commands/git-tracked.ts`. The jq, pipe and Git core-hook patches are
rejected experiments. See [the report](../agent-shell-structural-optimizations-2026-10-11.md).

## Replay

From the repository root, with the lockfile's dependencies installed:

```sh
node bench/agent-shell-structural-2026-10-11/restore.mjs /tmp/vfs-structural-replay
MATCH_RECORDING=1 COMMIT_CYCLE=1 node bench/agent-shell-structural-2026-10-11/git-delta.mjs /tmp/vfs-structural-replay/baseline /tmp/git-warm.json /tmp/vfs-structural-replay/candidate
MATCH_RECORDING=1 COMMIT_CYCLE=1 COLD_COMMAND=1 node bench/agent-shell-structural-2026-10-11/git-delta.mjs /tmp/vfs-structural-replay/baseline /tmp/git-cold.json /tmp/vfs-structural-replay/candidate
FIXED_GIT_TIME=1 PAIRS=10 WARMUPS=1 node bench/three-hour-2026-10-10/local-pairs.mjs /tmp/vfs-structural-replay/baseline /tmp/vfs-structural-replay/candidate /tmp/full.json
```

The restore destination must not already exist. `restore.mjs` verifies graph
hashes and restores both versions; no historical build directory is required.
`archive.mjs` produced these archives from compiled source and demo modules.
The Git target has 1,000 files in 50 directories, edits 10 files in 10 directories,
uses three warmups and 20 alternating pairs, and verifies exact status, diff
blocks and commit IDs. Both implementations record filesystem changes. Local
`totalRatio` includes edits and staging, **not commit time**; `COMMIT_CYCLE=1`
commits between samples to exercise checkpoint lifetime. Cold mode recreates the
command before each sample, preserving the filesystem and Git repository.

For actual Cloudflare replay, restore the graphs, link `baseline` and `candidate`
under the ignored `bench/three-hour-2026-10-10/compiled/` directory as
`structural-baseline` and `structural-wrapper-final`, and deploy `worker.ts` to a
private evaluation Worker using your own account/namespace and token. The
For a cold tracker comparison, also set `COLD_COMMAND=1` with `remote-git.mjs`.
`WARM_HASHES=1` additionally runs status/diff before the timed edit, isolating
tracker creation with matched content-hash warmth. The natural-history cold
comparison remains recorded separately.
The checked-in configs name the temporary services used for this experiment, not
public services. The token is read from the ignored
`bench/three-hour-2026-10-10/.dev.vars`; credentials are not archived.
Set `EVALUATION_URL` and `CANDIDATE` to the deployed URL/build label:

```sh
COLOCATED=1 CANDIDATE=structural-git-wrapper-v4 node bench/agent-shell-structural-2026-10-11/remote-git.mjs /tmp/cf-git.json
COLOCATED=1 PAIRS=10 WARMUPS=1 CANDIDATE=structural-git-wrapper-v4 node bench/agent-shell-structural-2026-10-11/remote-full.mjs /tmp/full-cf.json
```

The CF target includes Worker-to-DO RPC wall time and separately reports native
SQLite statement/read/write counters. Each pair reconstructs both arms in the
same DO to control placement. Edit/add/commit timers exclude setup and output
verification. An object restart discards and retries the entire pair, with a
bounded retry record. Build identity is checked on both Worker and DO.
Full-suite tests preserve all 190 public rows, with 10 alternating paired trials
and a separate native SQL profile; the primary score uses the original 146
uncached rows and reports the 44 cache rows separately.

## Evidence map

- `git-accepted`, `cf-git-accepted`: accepted wrapper, including symlink
  eligibility and per-operand `-C` validation; headline warm-path evidence.
- `git-wrapper-final`, `cf-git-wrapper-final`: preceding symlink-hardened wrapper.
  `wrapper-v2-overlay.json.gz` restores its tracker module over the final graph;
  `wrapper-v2-metadata.json` records its graph hash.
- `git-wrapper-cold`, `cf-git-wrapper-cold`: cold tracker overhead, deliberately retained.
- `full-local-wrapper`, `full-cf-wrapper`: complete default-command controls.
  The optional wrapper is not imported by these benchmark suites.
- `default-git-bundle-equivalence`: baseline and default candidate bundle hashes.
- `cost-recheck-*`: 10 repeats of a tiny failed-checkout counter difference.
- `check-accepted-release`, `bench-check-accepted-release`: final complete verification logs.
  Earlier checks remain as exploratory evidence.
- `cwd-before/after`: failing/passing repeated `-C` validation reproducer.
- `cf-default-aa`, `same-code-control.patch`: identical-implementation follow-up
  for the flagged complete-suite groups; the patch runs the baseline class on
  both sides. It was deployed only to the private evaluator.
- `internal-ignore-before/after`: failing/passing reproducer for an internal
  symlinked ignore dependency found during review.
- `local-iterator`, `local-lazy`, `targets-lazy`, `lazy-jq.patch`: rejected jq
  experiments. These are incremental result/input-value iteration, not a full
  byte-stream JSON parser. The original ten shell workloads form the headline;
  two extra comparator stresses do not change its weighting.
- `local-pipe`, `targets-pipe`, `direct-pipe.patch`: rejected direct pipe writer.
- `git-*`, `cf-git*`, `full-*-final` predating the `wrapper` names: exploratory
  core-hook integration, **not the accepted implementation**. The unqualified
  `cf-git` additionally compares recording off/on; its mutation write increase
  must not be attributed to the matched-recording experiment.
- `rejected-core-hooks.patch`, `core-hooks-graphs.json.gz`,
  `core-hooks-metadata.json`, `graphs-v4*`, `candidate-v3.json.gz`: rejected or
  intermediate compiled implementations retained for audit.
- `*-partial`, `*-interrupted`: incomplete runs; never used as headline evidence.

Large result JSON files and verbose diagnostic logs are gzip-compressed without
changing their contents. `.txt` files contain commands' diagnostics/summary output. The final graph
archive contains the retained library implementation; it does not include the
private benchmark Worker or credentials. The default Git bundle is unchanged,
so deployment of this library does not enable incremental staging in the public
shell. Hosts explicitly select the new command and already-enabled change feed.

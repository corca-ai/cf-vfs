# Bulk Git clone / checkout experiments (local only) — 2026-10-10

Both proposed optimizations were implemented and measured locally. Full object
store copy substantially reduces work. Checkout batching produces a smaller
improvement. **Neither prototype is adopted**: compatibility probes demonstrate
observable differences for open collaborative documents. Runtime source was
restored byte-for-byte; production was not deployed or changed.

## Workload and method

Node v24.18.0, actual NodeSqlFileSystem SQLite storage. Baseline includes the
previously deployed directory-metadata reuse optimization. No timing
instrumentation, three warmups and ten alternating baseline/candidate pairs
per experiment. SQL / file-read counters are collected in separate instrumented
runs and stop before verification. Timing rows must not be pooled between
experiments, whose baselines vary slightly.

The clone workload has 1,000 deterministic printable 768-byte files, two
committed generations with every body modified without shrinking, about 2,000
loose blob objects, and a complete checkout. The mixed workload replaces four
files with 256 KiB bodies. Checkout-all switches the same 1,000 changed files
back to their first commit. Every trial starts with a new SQLite filesystem;
fixture setup is excluded. Post-command verification checks clean status and
representative body length; focused tests separately exercise history, modes,
binary bodies, roots and symlinks. This is not an exhaustive byte-by-byte
verification of all clone objects.

**These are local SQL counts, not the earlier Cloudflare 39,665-statement
measurement.** Backend options and host layers differ. No Cloudflare speedup is
inferred from these numbers.

## Results

| Experiment | Baseline median | Candidate median | Median paired ratio | SQL before → after |
|---|---:|---:|---:|---:|
| Per-fanout-directory copy | 209.79 ms | 294.88 ms | 1.4094 | not separately profiled |
| Whole object-store copy | 201.80 ms | 116.16 ms | 0.5750 | 46,177 → 16,834 |
| Whole copy, mixed files | 214.76 ms | 132.79 ms | 0.6183 | not separately profiled |
| Checkout batch, immediate microtask, clone total | 208.31 ms | 210.95 ms | 1.0140 | 46,177 → 46,177 |
| Checkout batch, timer gathering, clone total | 205.14 ms | 196.60 ms | 0.9537 | 46,177 → 41,337 |
| Checkout batch, timer gathering, checkout-all | 145.69 ms | 140.97 ms | 0.9658 | 14,937 → 13,033 |
| Whole copy + timer batch, clone total | 207.87 ms | 112.82 ms | 0.5445 | 46,177 → 11,994 |
| Whole copy + timer batch, mixed clone | 219.13 ms | 125.45 ms | 0.5755 | see `whole-batch-mixed-sql.json` |

The combined small-file result is about **46% lower latency and 74% fewer SQL
statements**. The 95% paired bootstrap ratio interval is [0.5372, 0.5515]. Whole
copy alone is about 42% faster with 64% fewer statements; its interval is
[0.5738, 0.5817]. These estimates describe this local fixture only.

Whole copy reduces file-body reads from 3,067 to 1,063. The remaining reads
include Git metadata and checkout blobs. Timer batching groups 1,000 worktree
writes into 32 calls (31 batches of 32 and one of eight); body reads stay at
3,067 when batching is tested alone. Immediate microtasks and an eight-microtask
window still produced singleton batches and no SQL reduction. A zero-delay
native timer lets requests accumulate, while each write promise resolves only
after its batch commits; this is not the previously discarded attempt to use
timer barriers for Cloudflare CPU timing.

## Implementation experiments

1. `fanout-copy.patch`: use existing recursive `copy` for absent flat object
   subdirectories with ordinary inline files and matching creation permissions.
   Repeated copy setup was slower; rejected.
2. `whole-copy.patch`: for a fresh clone only, enumerate/validate the object
   tree, account logical read/write I/O and per-entry checks, remove the empty
   `info`/`pack` placeholders created by git init, then replace the empty object
   root using one recursive SQL copy. Nonstandard modes, owner identities,
   symlinks and opaque bodies fall back to the old walker. Transfer into an
   existing repository retains the original merge/skip-existing behavior.
3. `checkout-batch.patch`: a private adapter coalesces concurrent worktree
   `writeFile` requests via existing `writeFiles`, at most 32 entries / 128 KiB
   per batch, holding budgeted bytes until completion. Commits are serialized;
   metadata/index/HEAD writes and symlinks remain on their original paths.
   Buffer-poor backends and large individual bodies fall back to single writes.
   A conservative creation-only variant was also tried with immediate gathering
   (`whole-combined.json`): 203.81 → 131.06 ms including whole copy, slower than
   whole copy alone. It was superseded by the explicit broader batching probe.

These are exploratory prototypes, not reviewed production-safe implementations.
No public FS API was added. General adoption would require a trustworthy way to
select coherent bulk operations and single-file fallbacks without bypassing
execution limits or causing double charging after a failed batch.

## Compatibility findings and rejection

`semantics.mjs` operates through the actual CollaborativeFileSystem, DocumentRegistry
and Git applet, with deterministic reproductions saved in `semantics.json`:

- Open `/repo/.git/objects/info/note`, modify its document without publication,
  then clone. Baseline clone copies `pending\n`; bulk clone copies `stored\n`.
  `readFile` presents pending text while existing `copy` forwards to stored
  bytes. The prototype changes observable clone bytes.
- Keep `/repo/f0` open as a clean collaborative document, then force checkout
  another commit. Baseline succeeds and changes the document to `base\n`.
  Batched checkout fails because collaborative `writeFiles` deliberately refuses
  open documents; the document stays `stored\n`.

Even a same-size pending edit cannot safely be detected from file size. Mutation
tokens are opaque and should not be parsed to recognize one particular wrapper.
Catching ENOTSUP and retrying single writes also needs care: scoped mutation
budgets have already been charged for the refused batch. A blind retry changes
limit behavior. Therefore **the speed gains do not justify adoption yet**.

The object-copy and initial conservative combined prototypes passed the five
focused Git suites (48 tests). Broad batching passed 45/48 in those same suites;
three old writeFile-based fault/stall probes no longer triggered because writes
now use writeFiles (`batch-validation.log`). These three are instrumentation
incompatibilities, not independent proof of a storage bug; the two collaborative
probes above are actual behavioral regressions. Failure, cancellation and reset
fault injection must include batch writes before any future adoption.

## Artifacts and reproduction

`summary.json` collects results; individual JSON files retain all timing pairs,
confidence intervals and separate SQL counters. `whole-combined.json` and
`combined.json` are superseded exploratory combinations, not the final timer
batch result. `restoration.json` verifies all three touched runtime source files
match the pre-experiment copies, and the experimental helper was removed.

The patches compose independently. For a future isolated checkout, build and
copy baseline `dist` into a sibling snapshot; snapshot module resolution needs
access to this project's `node_modules`. Apply one or both patches, then build.

```sh
node bench/git-bulk-local-2026-10-10/compare.mjs BASELINE_DIST CANDIDATE_DIST OUTPUT.json
PROFILE_DIFF=1 node bench/git-bulk-local-2026-10-10/compare.mjs BASELINE_DIST CANDIDATE_DIST PROFILE.json
MODE=checkout-all node bench/git-bulk-local-2026-10-10/compare.mjs BASELINE_DIST CANDIDATE_DIST OUTPUT.json
MIXED=1 node bench/git-bulk-local-2026-10-10/compare.mjs BASELINE_DIST CANDIDATE_DIST OUTPUT.json
node bench/git-bulk-local-2026-10-10/semantics.mjs BASELINE_DIST COPY_DIST BATCH_DIST OUTPUT.json
```

After restoration the full check is recorded in `restored-validation.log`.
No remote Cloudflare operations or deployments were performed.

Restored-source validation: the main check passed build, type checks, lint,
unused-code checks and all 1,923 Node tests. The Workers suite could not start
under the current sandbox: `listen EPERM 127.0.0.1` and Wrangler's default log
directory is not writable. This is an environment limitation, not a passing
Workers result. The focused restored Git tests and remaining non-server gates
were run separately. The production/runtime source remains the pre-experiment
version, as verified by `restoration.json`.

The separate restored checks passed POSIX 46/46, comparison protocol, execution
limits, quality and docs. `npm pack` initially encountered the sandbox's
read-only default npm cache; rerunning the package gate with
`npm_config_cache=/tmp/cf-vfs-bulk-npm-cache` gets past packing but requires
network dependency installation; the package gate is not verified in this
restricted environment. All twelve bundle budgets passed in the separate check. The focused restored Git suites passed
48/48. Workers remains unexecuted because local listening is prohibited.

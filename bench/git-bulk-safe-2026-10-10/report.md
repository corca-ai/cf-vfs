# Safe bulk Git operations — local evaluation, 2026-10-10

Adopted guarded whole-object-store copy for fresh local clones and bounded
checkout writes. The previous prototypes' two collaborative-document regressions
are fixed. The measurements below were completed locally before deployment.

## Measurements

Node v24.18.0 and actual NodeSqlFileSystem SQLite storage. The baseline is the
source immediately before these changes, including previously deployed directory
metadata reuse. Each workload uses three warmups and ten alternating pairs,
without profiling. SQL counters come from a separate instrumented run. All
workloads use 1,000 deterministic 768-byte files. Clone has two full committed
generations; mixed clone replaces four files with 256 KiB bodies. Checkout-all
switches all changed files to the base branch; checkout-one changes only one file
between generations. Collaborative clone uses CollaborativeFileSystem with an
empty DocumentRegistry over the same SQLite backend.

| Workload | Before median | After median | Median paired ratio | Bootstrap 95% ratio interval |
|---|---:|---:|---:|---:|
| clone | 197.58 ms | 107.70 ms | 0.5442 | [0.5403, 0.5621] |
| clone-mixed | 208.96 ms | 123.42 ms | 0.5899 | [0.5876, 0.5957] |
| clone-collab | 209.63 ms | 113.37 ms | 0.5403 | [0.5354, 0.5449] |
| checkout-all | 144.77 ms | 141.87 ms | 0.9792 | [0.9564, 0.9835] |
| checkout-one | 64.42 ms | 65.14 ms | 1.0074 | [0.9819, 1.0156] |

Clone latency falls about 46%, mixed clone about 41%. SQL statements fall from
46,177 to 11,995 (74%); individual reads fall from 3,067 to 1,063. Checkout-all
improves about 2%. Checkout-one costs about 0.7 ms more in the marginal medians;
the paired confidence interval includes no change. Timer gathering adds a possible
scheduling delay to a small checkout. These local counts are not the earlier
39,665-statement Cloudflare workload, and do not establish a Cloudflare speedup.

Each trial verifies all 1,000 worktree bodies byte-for-byte and a clean Git status
after stopping the clock and capturing counters. Setup and verification are
excluded from timing. No concurrent timing runs or tests ran during comparisons.

## API and implementation

One optional read-only method, `canUseBulkOperation(operation, path)`, exposes
whether existing recursive copy / writeFiles operations preserve the filesystem
view's ordinary read/write behavior. Missing hints select the old path. SQL views
report eligibility; collaborative views exclude open paths and, for copy, open
descendants, including resolved aliases. The shell forwards the hint through its
policy boundary; reserved devices refuse it. Wrappers overriding read/write
semantics must override or omit the hint. It is not authorization or a lock.

Fresh clone alone replaces an initialized empty object directory. Preflight
requires ordinary inline bodies, default ownership/creation modes and no hard
links. Unsupported entries use individual transport and reuse preflight listings.
Fetch/push retain their existing individual merge behavior. Logical bytes, buffer
checks, cancellation, scope, mutation limits and actual storage quotas remain
active. Source read permissions are enforced by the existing copy implementation.

Checkout coalesces at most 32 worktree files or 128 KiB, retaining budget leases
until completion. Large files, low buffer headroom and open documents use single
writes. Eligibility is rechecked before publishing: a document opened while a
write waits selects single I/O without retrying a rejected batch or double-charging
I/O. Each promise reports its own committed write, even if a later single fallback
fails. Engine metadata writes are excluded. Device sink helpers were moved into a
private module to keep the existing code-size gate passing.

Hosts must serialize repository operations and document open/close/edit changes.
This is not a whole-checkout transaction. Earlier batches can commit before a
later failure; the existing force-checkout repair path remains necessary.

## Validation

- All 1,940 Node tests pass (95 files), including 17 new focused safety cases.
- POSIX comparison: 46/46 match. Tree shaking and bundle budgets: 12/12 presets pass.
- Typecheck, lint, knip, quality, execution limits, documentation and benchmark
  comparison protocol pass. Lint retains existing unrelated informational/warning
  diagnostics.
- Focused cases cover same-size unsaved object text through aliases, open checkout
  documents, late document opens, per-write success after later fallback failure,
  cancellation and lease release, legacy implementations without hints, shell
  roots, reserved devices, restrictive umask, unusual object modes, exact logical
  I/O/mutation/buffer budgets, real storage quotas and force-checkout recovery
  after a failed real batch.
- The existing stalled checkout isolation test now stalls writeFiles as well as
  writeFile. The legacy single-write recovery probe explicitly disables the hint;
  batch failure is exercised separately in the new tests.
- After filesystem/network restrictions were lifted, all 155 Workers integration
  tests (14 files) and package tarball/runtime/type consumer checks passed.
  Actual Cloudflare batch interruption/reset behavior is not established; the
  previous reset probe must inject writeFiles failures for that evaluation.

## Reproduction

Build baseline into a separate directory before applying the implementation,
then build the candidate with `npm run build`:

```sh
node bench/git-bulk-safe-2026-10-10/compare.mjs BASELINE_DIST dist OUTPUT.json
MIXED=1 node bench/git-bulk-safe-2026-10-10/compare.mjs BASELINE_DIST dist OUTPUT.json
COLLAB=1 node bench/git-bulk-safe-2026-10-10/compare.mjs BASELINE_DIST dist OUTPUT.json
MODE=checkout-all node bench/git-bulk-safe-2026-10-10/compare.mjs BASELINE_DIST dist OUTPUT.json
MODE=checkout-one node bench/git-bulk-safe-2026-10-10/compare.mjs BASELINE_DIST dist OUTPUT.json
PROFILE_DIFF=1 node bench/git-bulk-safe-2026-10-10/compare.mjs BASELINE_DIST dist OUTPUT.json
```

Raw paired measurements, SQL counts, semantic probes and test logs accompany this
report. The baseline snapshot for this session was `/tmp/cf-vfs-bulk-safe-baseline`
(containing compiled files directly, not a nested dist directory).

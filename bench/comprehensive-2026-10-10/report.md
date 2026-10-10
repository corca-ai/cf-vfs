# Comprehensive benchmark protocol and overview — 2026-10-10

This change adds measurement/approval tools and UI, not a filesystem speedup.
Future performance changes must follow the full-suite protocol in AGENTS.md and
[performance.md](../../docs/performance.md#comprehensive-regression-protocol).

## Delivered

- Four equal-weight geometric-mean indices: uncached overall, files, Git/coding/
  recovery, and metadata-cache variants. Reference = oldest comparable point,
  index 100. All file counts participate; workload picker affects tables only.
- Existing history supplies six comparable points in the initial preview;
  four incompatible workload cohorts are omitted. Zero/invalid times exclude
  the same workload from every point. Coverage/exclusion counts are visible.
- Latest-vs-previous >5% slowdown count keeps individual drops visible even if
  the aggregate improves. Descriptive trends never approve a performance change.
- Existing ten-commit replacement and ten-minute request cache stay in place.
  New history also records engine/measurement; older points lack this metadata.
- `bench:public:local` runs the full public plan against a chosen checkout,
  verifies bytes and captures SQL statement counts. `bench:assess` rejects
  mismatched plans/protocols, reports geometric means, individual slowdowns,
  unresolved zero times, SQL coverage/cost increases, and exits 2 for review.
  `bench:public -- --baseline ...` now prints aggregate screening too;
  `--check-regressions` makes review flags return exit 2.

## Evidence

`before.json`: full deployed baseline (`0c544003`, Worker
`afaeebd3-f606-46bd-b69f-f7bdbd654cf8`), 190 workloads, 60,648 checks.
`local.json`: full local plan with statement instrumentation, 190 workloads,
60,648 checks. Its dirty flag is explicit because tooling/UI were being edited;
no library implementation changed. The local plan uses the same setup, warmup,
three trials and final-body validation points as the public RPC plan.

Tests cover unlike-duration weighting, cache isolation, invalid/zero handling,
fixed cohorts, protocol mismatch, duplicate rows, hidden individual regressions,
and independent SQL increases. Existing store tests confirm same-commit history
replacement and TTL, and now check saved protocol metadata.
Desktop/mobile browser preview shows all four graphs using real saved CF data;
390px viewport has no document overflow. Aggregate indices are independent of
the table workload selector. Identical saved-result CLI comparisons correctly
return ratios 1, no regressions; this is tool validation, not a measured speedup.

## Deployment and full-suite screening

Source commit `6c6cfbfa90c2657e34e1cb9223e75455ff767be4`, public Worker
`ca0b1fce-cb3f-4d61-a076-472de75a43a4`. The full deployed run (`after.json`)
again completes 190 workloads and 60,648 checks. Build/commit/run IDs are
verified by the runner. `comparison.json` is the strict assessment output.

| Family | Candidate / baseline geometric mean |
|---|---:|
| Uncached overall | 1.026 |
| Uncached files | 1.020 |
| Uncached Git/coding/recovery | 1.027 |
| Metadata-cache variants | 0.991 |

The tool correctly returns **review required** (exit 2): 66 workloads exceed
+5%, zero unresolved timings, and the worst median ratio is 9.91. This is not a
performance win or a regression-free performance approval. No library source
changed (`git diff ea885f1 6c6cfbf -- src` is empty), and the UI/tooling-only
exception applies; retained changes make these observations visible rather than
claiming an engine acceleration. These unpaired three-sample runs cannot
attribute the differences to a cause. Examples of raw timings in milliseconds:

- coding-small/checkout-main/1000: [181,154,201] → [1794,154,1919]
- coding-mixed/diff/1000: [141,118,105] → [683,975,1140]
- coding-mixed/clone/1000: [1106,298,265] → [1783,1644,1913]

Do not silently discard these flags as noise. A future engine optimization
requires the paired follow-up specified by the protocol before adoption.
Public rows have no SQL counters (coverage 0/190); the report therefore makes
no assertion about CF SQL-cost changes. The local artifact records statement
counts only, not CF rows read/written.

Production browser verification confirms four aggregate graphs, visible
slowdown counts, latest commit metadata and no page overflow at 390px.
The deployed dashboard now shows seven comparable points and three omitted
cohorts. The latest source contributes one distinct history point; prior same-commit
reruns replaced their point. All 1,958 Node tests, 155 Workers tests, typechecks,
lint (existing informational diagnostics), quality, protocol, documentation,
unused-code checks and 12 bundle budgets pass. The new four arithmetic/cohort
regression tests pass after the final UI warning change.

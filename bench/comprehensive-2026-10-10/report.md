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

Post-deployment full CF evidence is added separately after completion.

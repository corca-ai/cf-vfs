# Paired benchmark measurement, 2026-10-12

This change repairs measurement; it makes no library acceleration claim.
The library source is unchanged from `cae52554` (implementation `4e449bb0`).

## Design

See [the protocol](../../docs/performance.md#fixed-reference-paired-production-measurement).
The demo bundles a frozen reference, compares alternating complete groups on one
scratch DO, and keeps coordinator/result I/O out of timed stage RPCs. Each run
contains one warmup pair plus six measured pairs for all 190 workloads. A single
commit point accumulates up to twelve full runs. Intervals use run clusters;
less than three runs stays provisional. The CLI separately compares the preceding
measured commit to prevent hiding incremental regression behind an old reference.

All samples survive, including zero timings; unresolved cohorts cannot become a
positive claim. Fixture, dependency and compatibility fingerprints guard the
reference. No filesystem API, library code or package bundle is changed.

## Verification

- `npm run check`: 2,043 Node tests, 158 Workers tests, POSIX oracle, protocol,
  documentation, package, type/lint and all twelve tree-shaking budgets passed.
- Actual local Workers integration through `bench/public-remote.mjs --url
  http://127.0.0.1:8795`: 190 rows, six samples per arm, 212,268 checks.
- Local clocks rounded some fast calls to zero: 24 rows unresolved. The UI and
  assessment correctly decline a full aggregate instead of excluding those rows.
- Local saved JSON is integration evidence only: it used an uncommitted working
  tree with the prior generated deployment label, not a production performance
  comparison. Browser checked workload selection, expanded history and absence of
  script errors.

## Production calibration

Pending the A/A runs on Cloudflare. Both arms contain the same library code.

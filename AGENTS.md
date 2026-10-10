# cf-vfs

Tree-shakable virtual filesystem primitives for Cloudflare Durable Objects and
R2.

Read [docs/index.md](docs/index.md) before changing the library. It is the
documentation entry point.

`CLAUDE.md` is a symlink to this file (`AGENTS.md`).

## Performance changes

For every performance change, follow [the comprehensive performance protocol](docs/performance.md#comprehensive-regression-protocol).
Capture baseline and candidate **full** local and actual Cloudflare suites with
matching workloads, engines and measurement protocols; a targeted benchmark
alone cannot approve adoption. Report per-workload regressions, equal-weight
geometric means (overall and families), and SQL statements/rows read/rows written
separately. Use `bench:public:local`, `bench:public`, and `bench:assess` for the
shared full plan and descriptive screening. Zero timings are unresolved, not
infinite speedups. Investigate every >5% slowdown with at least ten alternating
paired trials; smaller changes within noise are not proven wins. Retain a
performance candidate only when the overall improvement is supported and no
material per-workload or SQL-cost regression remains unexplained. Preserve
POSIX behavior and bundle budgets. Save raw evidence and rejected experiments.
After deployment rerun the full CF suite and verify the measured build/commit;
revert an unaccepted confirmed regression. A user may explicitly accept a
documented per-workload latency tradeoff when the full-suite geometric mean
improves; preserve the raw regression evidence and correctness/cost gates. UI-only/documentation changes need relevant
checks and UI verification, not claims of filesystem acceleration.

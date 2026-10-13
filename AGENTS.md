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
shared full plan and legacy descriptive screening. Use `bench:assess:paired` for
new paired production results, with at least three complete runs per version.
For paired local adoption evidence, use `bench:local:paired` with immutable
compiled baseline/candidate graphs. Its `local-group-v1` protocol creates fresh
fixtures per arm/group and completes a group before switching arms, matching CF.
Balance `ORDER_OFFSET=0/1` across preselected independent local sessions. Legacy
stage-interleaved local runs are screening evidence and must not be pooled with
the group protocol. Retain GC pauses; never trim or subtract them to fix a score.
Keep the reference frozen across library optimizations; do not repin it to erase
regressions. Verify A/A calibration and both reference and previous-commit
comparisons. Never cherry-pick runs, remove unresolved workloads or treat pairs
within one run as independent sessions. Zero timings are unresolved, not
infinite speedups. Investigate every >5% slowdown with at least ten alternating
paired trials; smaller changes within noise are not proven wins. Retain a
performance candidate only when the overall improvement is supported and no
material per-workload or SQL-cost regression remains unexplained. Preserve
POSIX behavior and bundle budgets. Save raw evidence and rejected experiments.
Finish deployment and logging configuration before measurement cohorts. Do not
attach or detach `wrangler tail` or dashboard live logs during measurements:
Cloudflare can replace Durable Objects when live logging is enabled, even with
an unchanged source build. Preserve affected runs as excluded diagnostics.
After deployment rerun the full CF suite and verify the measured build/commit;
revert an unaccepted confirmed regression. A user may explicitly accept a
documented per-workload latency tradeoff when the full-suite geometric mean
improves; preserve the raw regression evidence and correctness/cost gates. UI-only/documentation changes need relevant
checks and UI verification, not claims of filesystem acceleration.

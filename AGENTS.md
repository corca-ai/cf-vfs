# cf-vfs

Tree-shakable virtual filesystem primitives for Cloudflare Durable Objects and
R2.

Read [docs/index.md](docs/index.md) before changing the library. It is the
documentation entry point.

`CLAUDE.md` is a symlink to this file (`AGENTS.md`).

## Deploying to Cloudflare

Use the `cf` CLI for every Cloudflare deployment and account operation, never
`wrangler deploy`, `wrangler secret` or other Wrangler account commands.

- Public benchmark Worker (`vfs.borca.ai`): `npm run deploy:public`, which runs
  `cf deploy` from `eval/benchmark-deploy/`. Its Durable Objects are declared
  there as `exports`; once deployed that way the Worker cannot return to the
  `migrations` array in `wrangler.benchmark.jsonc`, so a Wrangler deploy of
  that file must not be attempted.
- Agent evaluation Worker (`eval.vfs.borca.ai`): `npm run deploy:eval`.
- Secrets: `cf workers secrets update`, or `--secrets-file` on deploy; never
  print a secret's value.

Wrangler remains only as a local tool: `wrangler types`, the Workers Vitest
pool, and the tree-shaking bundle checks. `wrangler.benchmark.jsonc` stays
because the benchmark fingerprint and local tooling read it; change it together
with `eval/benchmark-deploy/cloudflare.config.ts`.

## Performance changes

**Never run a large benchmark on Cloudflare unless the user explicitly
instructs it, in any circumstance** — not the deployed full suite or task
series, not a large lab experiment, not to verify a deployment or a release.
Cloudflare usage is billed, and full-scale runs there cost far more than they
tell. **Run large workloads (a 10,000-page wiki, the full benchmark plan) only
locally. On Cloudflare run only small experiments, about 200 pages, whose job
is to check that the pattern measured locally holds on Workers.** See
[the protocol](docs/performance.md#comprehensive-regression-protocol).

- Adoption evidence is local. Capture baseline and candidate **full** local
  suites (`bench:public:local`) with matching workloads, engines and
  measurement protocols; a targeted benchmark alone cannot approve adoption.
  Use `bench:local:paired` with immutable compiled baseline/candidate graphs
  for paired evidence: its `local-group-v1` protocol creates fresh fixtures per
  arm/group and completes a group before switching arms. Balance
  `ORDER_OFFSET=0/1` across preselected sessions. Investigate every >5%
  slowdown with at least ten alternating paired trials.
- Where Workers can differ from Node (runtime crossings such as streams and
  buffer allocation, SQLite page reads), answer on **local workerd** first:
  `npm run lab:local` serves the SQL lab with `cf dev` at no cost, and
  `LAB_URL=http://localhost:8787 LAB_TOKEN=local-lab-only` points the
  `bench/sql-lab` scripts at it. It reproduced the direction of every
  Cloudflare result on record and understates their size, most for stream- and
  allocation-heavy changes
  ([calibration](bench/local-workerd-2026-11-02/report.md)).
- A Cloudflare check is a small experiment before a release, or when local
  workerd cannot answer (production storage, RPC and placement, the absolute
  size of an allocation-heavy effect): in the SQL lab, about 200 pages, both
  versions bundled in one deployment and alternated in pairs (five pairs or
  fewer), minutes of Durable Object time in all. Destroy the lab when it ends.
- Do not run the deployed full suite or task series (`bench:public`), and do
  not deploy the public benchmark for a candidate, unless the user asks. Never
  retry a failed Cloudflare run or add runs to reach a result; report it.
- Report per-workload regressions, equal-weight geometric means (overall and
  families) and SQL statements/rows read/rows written separately. Retain GC
  pauses; never trim or subtract them. Keep the benchmark reference frozen; do
  not repin it to erase regressions. Never cherry-pick runs, remove unresolved
  workloads or treat pairs within one run as independent sessions. Zero timings
  are unresolved, not infinite speedups. Smaller changes within noise are not
  proven wins.
- Retain a candidate only when the overall improvement is supported and no
  material per-workload or SQL-cost regression remains unexplained. A user may
  explicitly accept a documented per-workload latency tradeoff. Preserve POSIX
  behavior and bundle budgets. Save raw evidence and rejected experiments.
- When the user asks for a Cloudflare suite run: finish deployment and logging
  configuration first, keep one evaluation topology for both arms, never attach
  `wrangler tail` or dashboard live logs during it, and preserve affected runs
  as diagnostics.

UI-only/documentation changes need relevant checks and UI verification, not
claims of filesystem acceleration.

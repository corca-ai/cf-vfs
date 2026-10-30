# A scaled evaluation environment — calibration, 2026-10-30

Agent evaluations on a 10,000-page wiki cost a minute of seeding per instance
and long tool outputs per step. The evaluation Worker now takes a `scale`: the
limits that grow with the data an execution works over are multiplied by it
(`scaledLimits` in `eval/profile.ts`, applied through `evalShell`), so a
2,000-page wiki at `scale: 0.2` should meet its limits where a 10,000-page
wiki meets the defaults.

`calibrate.ts` checks that locally with the evaluation shell profile. It runs
21 probe scripts, the ways agents list, search, loop over and summarize a wiki
(including `find`, `grep -r` pipelines, `for` over `$(find)`, `xargs`, awk and
awiki), on the S3 generator's wiki at 10,000 pages with the default limits, at
2,000 pages with limits scaled by 0.2, and at 2,000 pages with the default
limits. Build and run it like `eval:replay`:

```sh
npx esbuild bench/scaled-env-2026-10-30/calibrate.ts --bundle --platform=node \
  --format=esm --packages=external --outfile=node_modules/.cache/cf-vfs/calibrate.mjs
node node_modules/.cache/cf-vfs/calibrate.mjs FIXTURES OUT.json
```

## Results

| Run | Probes passing at 10,000 pages | Same outcome at 2,000 × 0.2 | Same outcome at 2,000 unscaled |
| --- | ---: | ---: | ---: |
| before (`before.log`) | 8 / 21 | 21 / 21 | 9 / 21 |
| `find` streams its walk (`after-find.json`) | 17 / 21 | 21 / 21 | 18 / 21 |
| awk `print` no longer charged twice (`after.log`) | 18 / 21 | 21 / 21 | 19 / 21 |

"Same outcome" means the probe succeeded on both, or stopped at the same
limit on both. Time at 10,000 pages was 3.8–7.2 times the time at 2,000
(1.9 for one probe that reads only the first 500 pages), close to the
expected 5.

The scaled environment reproduced every success and every limit of the large
one, before and after the fixes; the unscaled small one missed most failures
before them. The probes found:

- `find` stopped at 10,000 matches, which broke nine of the probes: every way
  of listing the wiki through `find`. It held its whole walk before evaluating
  it; it now evaluates page by page and charges expansion work per entry
  scanned, as `grep -r` does.
- awk charged the bytes `print` writes to expansion work, twice (once joining
  the fields, once adding `ORS`), so a `grep | sed | awk` pipeline over the
  wiki's 99,271 link lines stopped at 10,000,000 units. Output already counts
  against the output and I/O limits.

Three probes still stop at 10,000 pages, by design or by a limit that is a
product decision:

- `find | while read; do head ...; done` runs 20,000 commands, the
  `maxCommands` limit.
- `cat` of every page into one pipe passes 8 MiB through a pipeline edge;
  `maxPipelineBytes` counts the bytes an edge carries, not those it holds,
  and hosts cannot raise it past 8 MiB.
- `awiki graph -json | jq` over 10,000 pages parses 7.6 MB, past the 16 MiB
  buffered-byte limit once held as values.

## On Cloudflare

`cf-check.mjs` ran nine of the probes on the evaluation Worker (version
c84753cd, after the fixes) against a 10,000-page instance with default limits
and a 2,000-page instance at scale 0.2 (`cf-check.log`, `cf-check.json`). One
run each.

- Every outcome matched: eight probes succeeded on both, and `cat` of every
  page stopped at the pipeline edge limit on both.
- Heavy probes took 4.6–6.1 times as long at 10,000 pages (`grep -rl` 6.5 s
  vs 1.1 s, the inbound pipeline 19.4 s vs 3.7 s, `awk` over every page 16.7 s
  vs 3.7 s, a first `awiki lint` 10.9 s vs 2.0 s), so the scaled 6 s deadline
  sits where the 30 s one does.
- Light probes took only 2.6–4.1 times as long (`find` 530 ms vs 203 ms):
  about 150 ms per execution does not shrink with the wiki. A scaled
  environment therefore understates how fast cheap commands feel at full size,
  and nothing near the deadline is cheap.

At full size two ordinary whole-wiki pipelines take 17–19 s of the 30 s
deadline on Cloudflare; an agent that chains two of them in one execution
would be stopped.

Not covered: how long an agent waits in absolute terms, which a scaled
environment does not reproduce.

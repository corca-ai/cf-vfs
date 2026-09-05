# Text processing: second pass, 2026-09-05

This measures incremental gains over `6fa62a3`, which already removed repeated
whole-input regex arrays. It does not compare against the much slower
`fedaf0e` baseline of the [first pass](text-processing-2026-09-05.md).
[Raw measurements](text-processing-follow-up-2026-09-05.json) include both
measurement rounds and percentile samples.

## Changes retained

- Recognize exact strings from the compiled POSIX instruction program and use
  `indexOf`/`includes`. Parsing and program-size validation still happen first,
  so basic/extended syntax, escaped metacharacters, and ASCII case folding keep
  their existing meaning. Capturing groups, anchors, alternatives, and lone
  surrogates retain the NFA path. Exact singleton sets and fixed repetitions
  can also qualify.
- Existence-only searches skip capture-array copying and group-string creation,
  and finish at the first accepting state. `exec()` keeps ordered matching and
  greedy captures. Both NFA paths retain the 20-million-step bound.
- Reuse thread objects between input positions within one search. There is no
  cross-call cache: retained thread slots are bounded by the compiled program,
  and search state is discarded when the call ends. Input-length-proportional
  thread-object churn is removed; capturing searches still copy capture slots.
- Append plain sed replacement strings in one piece through `SedText`, retaining
  expansion-work, character, and shared-buffer checks. This also counts complete
  UTF-8 characters correctly on this path. Replacements with `&` or backslash
  escapes keep their existing expansion logic.

Intermediate Node measurements showed the thread reuse reduced long-record
regex cases from roughly 6.0–7.0 ms to 4.3–5.1 ms. Batching plain replacements
then reduced the 5,000-line sed case from 3.9 ms to 2.7 ms. These are separate
warm runs, not allocation or CPU profiles.

## Method

Apple M5 Max, Darwin 25.5.0 arm64; Node 26.8.1, workerd 1.20260714.1,
Wrangler 4.114.0, Workers Vitest pool 0.18.6. There were no deployments.

The same `text-processing-cases.json` and benchmark harness were used in an
isolated baseline worktree and the edited checkout. Node imported a saved
baseline `dist` directory. The first workerd round ran before/after with three
executions per sample; the final round ran after/before with ten to reduce
millisecond-timer quantization. The final Node pair also ran after/before.
Measurements used three warm-ups and eleven samples; tables show medians.
Builds and other tests did not run concurrently with these benchmarks.

Every shell execution verifies exact output and successful exit. Each workerd
case asserts **2 SQL statements, 2 rows read, and 0 rows written**. Input setup
is outside the measured region. Output validation remains inside it on both
versions. Dense cases use 4,000 characters, short-record cases 5,000 lines,
and the added long-record cases 72,000 ASCII bytes matching repeated groups.

## Results

Times are milliseconds per command. Reduction is local workerd elapsed time.

| Workload | workerd before → after | Reduction | Node before → after |
| --- | ---: | ---: | ---: |
| `sed-global-dense` | 2.700 → 1.000 | 63.0% | 1.737 → 1.055 |
| `grep-only-matching-dense` | 1.500 → 0.400 | 73.3% | 1.258 → 0.533 |
| `awk-gsub-dense` | 1.200 → 0.300 | 75.0% | 1.091 → 0.360 |
| `awk-regex-split-dense` | 0.900 → 0.800 | 11.1% | 0.945 → 0.902 |
| `grep-short-lines` | 4.400 → 1.200 | 72.7% | 3.766 → 1.454 |
| `sed-short-lines` | 7.300 → 2.900 | 60.3% | 6.370 → 2.719 |
| `awk-short-lines` | 2.700 → 2.600 | 3.7% | 2.544 → 2.476 |
| `grep-regex-long-record` | 7.900 → 4.800 | 39.2% | 6.877 → 4.389 |
| `awk-regex-long-record` | 7.900 → 4.900 | 38.0% | 6.877 → 4.373 |
| `sed-capture-long-record` | 8.000 → 5.700 | 28.7% | 6.848 → 5.180 |

The regex-split and non-regex AWK controls are effectively unchanged at this
resolution; their small differences are not claimed as improvements. UTF-8
microbenchmarks remain controls because this pass does not change the encoder.
The earlier workerd round also improved the targeted workloads: short-record
search/substitution by 57–69% and long-record regex cases by 26–32%.

These are local elapsed times, not deployed DO CPU, billing, or end-to-end
latency. The final workerd sampling quantum is 0.1 ms per command, so small
absolute changes still need caution. No heap reduction percentage is inferred
from the thread reuse.

## Correctness and cost

`bench/regex-differential.mjs` compares both APIs with the saved baseline:
81 pattern forms, 78 texts, both dialects, both case modes, and UTF-16 start
offsets including fractional, NaN, and infinite values. All **273,780** result
comparisons matched, including captures. Existing unit tests also pin
malformed-pattern diagnostics.
Targeted unit tests cover literal syntax, surrogate boundaries, boolean/capture
agreement, and sed expansion/byte limits. An additional external-process
watchdog checks that both regex APIs still reject expensive failed searches.

`npm run check` passed: 1,674 Node tests, 106 workerd tests, 14 isolated-process
limit checks, and the type, lint, unused-code, complexity, documentation,
package, and tree-shaking gates. All nine bundle presets remain within their
existing budgets; no budget or dependency was changed.
`npm run bench:check` passed all 17 Node measurements and 20 workerd benchmark
tests; `npm run bench:text` also passed all output assertions.

| Preset | Before | After | Change |
| --- | ---: | ---: | ---: |
| AWK | 93,972 | 95,775 | +1,803 bytes |
| Default registry | 497,657 | 499,561 | +1,904 bytes |
| Linux profile | 669,341 | 671,245 | +1,904 bytes |

The VFS, minimal shell, interactive, R2, `ls`, and small command-registry
presets retain exactly their previous sizes. SQL costs and all execution
limits remain unchanged.

## Reproduce

```sh
npm run bench:text
npm run bench:check
# A saved baseline contains compiled JS under its dist directory:
node bench/text-processing.mjs /path/to/baseline/dist
node bench/regex-differential.mjs /path/to/baseline/dist
```

For a workerd A/B comparison, create an isolated checkout of `6fa62a3`, install
or link the identical dependencies, and copy the current
`bench/text-processing-cases.json` and `bench/text-processing.bench.ts` into it.
Run this sequentially from each checkout:

```sh
npx vitest run --config vitest.performance.config.ts --disableConsoleIntercept bench/text-processing.bench.ts
```

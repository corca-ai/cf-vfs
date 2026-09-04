# Text-processing performance — 2026-09-05

Repeated searches no longer rebuild arrays for an entire input on every match.
The Thompson matcher reads code points directly from the original string and
keeps capture positions in UTF-16 units. Its pattern semantics and instruction
budget remain the same. This removes quadratic input preparation from dense
`sed` substitutions, `grep -o`, AWK `gsub`, and regex field splitting.

`utf8ByteLength` also skips encoding for ASCII strings of at most 128 UTF-16
units. Larger text and non-ASCII text retain the native `TextEncoder` path.
These changes affect three source files and add no dependencies or caches.

## Method

- Baseline: `fedaf0e`, including the completed correctness and resource-limit fixes.
- Apple M5 Max, Darwin 25.5.0 arm64, Node 26.8.1.
- Local workerd 1.20260714.1, Wrangler 4.114.0, Workers Vitest pool 0.18.6.
- Both runtimes use the same [seven workloads](text-processing-cases.json).
  Dense cases use a 4,000-character record; ordinary cases use 5,000 short records.
- Three warmups and eleven measured samples. Node times one complete shell
  execution per sample. workerd batches three executions per sample and reports
  amortized time to reduce local timer quantization.
- Exact stdout is verified. Input creation and shell construction are outside
  the measured region; VFS reads, decoding, execution, and output collection are inside.
- `maxSteps` is 1,000,000 for both versions; other execution limits retain their defaults.
- Node A/B runs were repeated in both orders. The final reversed-order pair is
  recorded below. workerd uses separate current/baseline worktrees with the same
  dependencies and benchmark files. Versions were measured sequentially.

[Raw results and environment](text-processing-2026-09-05.json) are retained.
These are local execution measurements, not deployed RPC or production latency.

## Complete command execution

Median milliseconds, including correctness assertions in both versions:

| Workload | Node before | Node after | workerd before | workerd after | workerd reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| sed global substitution | 76.649 | 1.759 | 101.000 | 3.667 | 96.4% |
| grep matching parts | 76.175 | 1.302 | 80.667 | 2.000 | 97.5% |
| AWK gsub | 76.314 | 1.195 | 79.000 | 1.333 | 98.3% |
| AWK regex split | 39.639 | 0.919 | 41.667 | 1.333 | 96.8% |
| grep short records | 5.062 | 3.761 | 7.333 | 6.333 | 13.6% |
| sed short records | 11.613 | 6.469 | 19.000 | 9.667 | 49.1% |
| AWK short records | 3.895 | 2.523 | 6.000 | 3.333 | 44.4% |

Every command remains **2 SQL statements, 2 rows read, 0 rows written** in
workerd. Node also reports 2 statements and 2 returned rows; returned rows are
not Cloudflare billing metrics. No SQL code or storage schema changed.

The short ASCII byte-count microbenchmark (100,000 calls on an 18-character
string) fell from 11.040 to 1.108 ms. The dense-regex gains mostly come from
direct input traversal: before adding the ASCII fast path, Node sed already
fell to 2.684 ms and AWK gsub to 1.154 ms.

The unrestricted ASCII scan candidate was rejected. On an 8 KiB ASCII string,
10,000 calls took about 40.9 ms versus 3.6 ms for native encoding. The retained
128-unit cutoff avoids that extra scan. Large-string controls remain on the
native path; their small, variable timing differences are not claimed as gains.
The final ASCII 8 KiB control was 4.592 versus 4.833 ms; an earlier paired run
was 4.695 versus 4.622 ms.

## Bounds, compatibility, and bundle cost

No execution limit was raised in the library. The matcher still checks its
instruction budget, and shell byte/work limits remain active. A deterministic
comparison against the baseline matched all 63,544 generated results, including
Unicode, captures, anchors, and fractional starting offsets. Dedicated tests
cover surrogate pairs, unpaired surrogates, empty matches, and UTF-8 counts
around the short-string cutoff.

The matcher removes the full-input character, offset, and numeric-code arrays.
This is an algorithmic allocation reduction; no peak-heap measurement is claimed.

Existing bundle ceilings are unchanged. The ASCII fast path adds 91 bytes to
presets that do not include the regex engine. Presets with both changes grow
by 63 bytes because direct offset handling removes 28 bytes from the engine.
The VFS is 179,734/188,032 bytes, AWK 93,972/98,816, the default registry
497,657/520,576, and the Linux profile 669,341/700,544. All nine presets pass.

## Reproduce

```sh
npm run bench:text
node bench/text-processing.mjs /path/to/baseline/dist
npx vitest run --config vitest.performance.config.ts --disableConsoleIntercept bench/text-processing.bench.ts
npm run bench:check
```

The optional module root must be a build of the desired baseline. For workerd
A/B, copy `text-processing.bench.ts` and `text-processing-cases.json` into the
baseline checkout's `bench/` directory, use the same installed dependencies,
and run the same Vitest command from each checkout. Timing thresholds remain
out of unit tests; the workerd benchmark asserts exact output and SQL cost.

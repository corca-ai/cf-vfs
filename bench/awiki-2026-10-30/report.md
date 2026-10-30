# awiki in the VFS — local measurements, 2026-10-30

`awikiCommand` (opt-in, `@corca-ai/cf-vfs/shell/commands/awiki`) follows the
native awiki. These measurements were taken against 0.5.0 (`corca-ai/awiki`
f65f8c4); 0.5.1 changed only `rename` link rewriting and `-h`, and the command
now follows it. This records how its output
compares with the native binary and what it costs over the 2,000-page wiki the
S3 agent scenario used (9.9 MB, `../regex-prefix-2026-10-29/local/s3-files.json.gz`).

No library path changes: the command is a new applet outside every existing
preset, which the tree-shaking check asserts. These are local Node SQLite
numbers only; nothing here was measured on Cloudflare.

## Output compatibility

- `test/awiki-differential.test.ts` replayed 9 recorded cases, 88 command
  steps, against `test/fixtures/awiki-compat.json` from the native binary:
  stdout, stderr, status and, after `format`/`rename`, every file. All match
  byte for byte, including seeded sampling (`suggest`, `avg-shortest-path`),
  near-duplicates in Latin and Hangul text, the round-half-even rate
  `orphan_rate=0.0312`, and native quirks (`awiki: __help__`, angle-bracket
  rename splicing).
- The same suggest output with a 96 KiB buffered budget, forcing many hash
  partitions, matches too.
- On the S3 wiki and a generated 2,000-page wiki (10.4 MB), `lint -r`,
  `wanted -r -n 20`, `suggest -r` (all sections), `links -r` and `path -r`
  match the native output.
- `test/awiki-cache.test.ts`: edits, removals and new pages are seen at once;
  a warm run charges exactly the reads of a cold one (asserted at the limit);
  `rename` rereads only the four pages involved out of 41.

## Timings

`node bench.mjs ROOT 7` on an Apple M5 Max, Node v24.22.1; median of 7 with
range, SQL statements and rows read per run (`bench.log`, `results.json`).
Native awiki ran on a disk copy of the same pages (formatted the same way).

| Run | cf-vfs | SQL statements / rows | Native awiki |
| --- | ---: | ---: | ---: |
| `lint -r`, first run (cold) | 440 ms [421–469] | 4,023 / 6,022 | 38 ms |
| `lint -r`, warm | 31.6 ms [31.2–418] | 2,023 / 4,022 | 38 ms |
| `links -r` one page | 28.6 ms [28.0–30.3] | 2,023 / 4,022 | 37 ms |
| `wanted -r` | 33.8 ms [30.8–37.5] | 2,023 / 4,022 | 38 ms |
| `path -r` | 35.9 ms [34.0–40.8] | 2,023 / 4,022 | — |
| `suggest -r` without near-duplicates | 73.1 ms [64.4–84.2] | 2,023 / 4,022 | 63 ms |
| `suggest -r --filter near-duplicates` | 2,318 ms [2,310–2,481] | 7,074 / 9,073 | 291 ms |
| `format -r`, nothing to change | 29.3 ms [28.5–31.1] | 2,023 / 4,022 | — |
| `rename -r` (3 linking pages rewritten) | 29.4 ms [28.9–32.2] | 2,063 / 4,045 | — |
| `lint -r` after editing 1 page | 30.7 ms [30.1–31.3] | 2,024 / 4,023 | — |
| `lint -r` after editing 100 pages | 50.1 ms [49.4–54.1] | 2,123 / 4,122 | — |
| grep pipeline: backlinks of one page | 75.2 ms [72.5–85.1] | 2,008 / 4,017 | — |
| grep pipeline: link targets ranked | 133.5 ms [131.6–145.1] | 2,008 / 4,017 | — |

The warm `lint -r` maximum is its first repetition, which followed a `format`
that rewrote every page. Native timings include process start and are not a
like-for-like comparison with an in-process command; they bound what the
native tool takes for the same answer.

Reading the numbers:

- Warm runs cost one statement per page (the empty read that returns the
  page's token) plus listings; the cold run adds one read per page. Change
  detection is therefore O(pages) per run; parsing is O(changed pages).
- The grep pipelines answer narrower questions than `links` or `wanted` and
  are still two to four times slower, because they rescan every byte.
- Near-duplicates are 8x slower than native. With the default 16 MiB buffered
  budget the kept fingerprints do not all fit (shingle sets total 22.8 MB on
  this wiki), so about 3,000 pages are rehashed for 4,402 candidate pairs.
  Successive fixes took the section from 30 s (deadline exceeded; the
  partition estimate reread everything 32 times) to 4.2 s (exact pass-0
  fingerprints) and 2.3 s (Belady eviction with a byte budget).

## Bundle

The `awiki` preset is 102,091 bytes (budget 107,264); no other preset reaches
any `shell/commands/awiki*` module.

## Not measured

- Cloudflare: cold start after eviction, the per-page token reads over DO
  SQLite, and memory in a 128 MB isolate.
- A 10,000-page wiki. The page cache holds 16,384 pages.

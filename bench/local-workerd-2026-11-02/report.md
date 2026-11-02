# Local workerd as a stand-in for Cloudflare — calibration, 2026-11-02

Question: can the SQL lab running on local workerd (`cf dev`, no Cloudflare
usage) answer the "does this hold on Workers?" questions that earlier needed
Cloudflare runs? Every measurement below repeats, unchanged, a script whose
Cloudflare result is already on record, over the same 10,000-page S3 wiki
(49.7 MB), timed from the client the same way. No new Cloudflare usage.

## Runtime operations (per operation)

`micro.log`, against `../sql-lab/micro-2026-10-30-wiki10k.log`,
`../sql-lab/micro-before-2026-10-31.log` and `../sql-lab/micro-2026-10-30-local.log`:

| Operation | Cloudflare | local workerd | Node | CF ÷ workerd |
| --- | ---: | ---: | ---: | ---: |
| function call | 0.076 µs | 0.011 µs | 0.013 µs | 7 |
| `await` | 0.12 µs | 0.019 µs | 0.023 µs | 6 |
| async generator step | 0.29 µs | 0.057 µs | 0.071 µs | 5 |
| abort listener | 3.1 µs | 0.47 µs | 0.09 µs | 7 |
| `TextDecoder` 5 KB | 1.55 µs | 0.22 µs | 0.20 µs | 7 |
| ASCII regex, 200 chars | 0.07–0.15 µs | 0.01 µs | — | 7–15 |
| byte stream, one chunk | 144 µs | 8.9 µs | 1.1 µs | 16 |
| default stream, one chunk | 73 µs | 3.8 µs | 0.6 µs | 19 |
| `Blob.stream()` | 333 µs | 15.7 µs | 16.8 µs | 21 |
| 5 KB buffer copy | 16.4 µs | 0.3 µs | 0.4 µs | 55 |

## SQL shapes (per 64-path batch, `entry-columns.log`)

| Query | Cloudflare | local workerd | ratio |
| --- | ---: | ---: | ---: |
| entries as 19 columns | 1.18 ms | 0.18 ms | 6.6 |
| entries as one JSON string | 0.56 ms | 0.06 ms | 9 |
| bodies | 6.24 ms | 0.68 ms | 9 |
| `length(body)` only | 4.32 ms | 0.60 ms | 7 |

## Commands: bulk against per-file reads (`bulk-read*.log`, medians of three)

| Command | Cloudflare bulk/per-file | local workerd bulk/per-file |
| --- | ---: | ---: |
| read every body, stream vs bulk | 0.40–0.47 | 0.29 |
| `grep -rlF` | 0.20 | 0.43 |
| `grep -rc` | 0.50 | 0.72 |
| cold `awiki lint` | 0.53 | 0.69 |
| `cat` / `grep -lF` / `wc -l` over 8,055 operands | 0.28 / 0.22 / 0.28 | 0.52 / 0.43 / 0.52 |

## Commands: version against version (`runtime-pairs*`, 8 pairs)

b7940f8's shell bundled beside a4fc3a3's (which carries the runtime-cost
change), as `../sql-lab/runtime-pairs-lab-scaffolding-2026-10-31.patch.txt`
did on Cloudflare:

| Command | Cloudflare | local workerd (95% bootstrap) |
| --- | ---: | ---: |
| `awk 'FNR == 1'` | 0.645 | 0.755 (0.745–0.763) |
| `awk '{ print $1 }' \| wc -l` | 0.734 | 0.771 (0.766–0.776) |
| `wc -l glob \| tail -1` | 0.929 | 0.974 (0.956–0.992) |
| cold `awiki lint` | 0.889 | 0.977 (0.965–0.987) |
| `grep -rc \| tail` | 0.971 | 0.984 (0.969–0.996) |
| `cat dir \| grep -c` | 0.955 | 0.963 (0.933–0.995) |

## What it says

- **Direction holds everywhere.** All 6 version pairs and all 9 bulk
  comparisons point the same way locally as on Cloudflare, and the runtime
  operations rank the same: streams and runtime crossings cost more than in
  Node on both.
- **Magnitude is understated locally.** Cloudflare runs ordinary JavaScript
  and SQL 5–9 times slower than local workerd, uniformly, so ratios between
  JavaScript-bound versions carry over. Streams cost a further 2–3 times more
  and buffer allocation about 8 times more on Cloudflare, so a change that
  removes streams or copies gains more there than locally: an effect of 0.43
  locally was 0.20 on Cloudflare.
- **Resolution is far better locally.** Intervals are a tenth as wide, with no
  session drift.

Local workerd therefore answers "does this change help or hurt on Workers,
and roughly how much" for free. Cloudflare is still needed for what local
workerd does not model — production storage (replication, output gates), RPC
and placement, and the absolute size of allocation- and stream-heavy effects —
and a small check before a release covers that.

# Small Cloudflare check before release, 2026-11-03

What it checks: that the local pattern of #131 (sed -i read-ahead, pipes
without a native stream per chunk) and #132 (grep without an await per line)
holds on Workers. Main before them (aa3be95) is bundled beside main after
them (e803715) in one SQL lab deployment (`../sql-lab/runtime-pairs-lab-scaffolding-2026-10-31.patch.txt`),
200 pages of the S3 wiki seeded (`../sql-lab/seed-pages-2026-11-03.mjs`;
160 of them at the depth `/wiki/*/*.md` matches), six commands, five
alternating pairs (`../sql-lab/pairs-2026-11-02.mjs`), timed at the Worker
around the Durable Object call. No warmup pair, so the first pair includes
cold starts.

On Cloudflare the lab was deployed with `cf` (3286f98e), the pairs took 21 s,
the lab object was destroyed and the clean lab redeployed (a3a42d5e). The
first attempt failed before sending a request: the client's TCP connections
to Cloudflare timed out right after seeding (connect ETIMEDOUT on every
address). Nothing ran, so the five pairs were run once after connectivity
returned; nothing else was repeated.

| Command | local workerd | Cloudflare (95% bootstrap) | Cloudflare pairs, before/after ms |
| --- | ---: | ---: | --- |
| `wc -l /wiki/*/*.md \| tail -1` | 0.875 | 0.919 (0.815–1.061) | 155/124 122/106 117/94 121/119 103/123 |
| `cat /wiki/*/*.md \| grep -c owner` | 0.843 | 1.079 (0.953–1.212) | 133/170 115/132 122/104 130/129 116/137 |
| `cat /wiki/*/*.md \| tr a-z A-Z \| wc -c` | 0.923 | 0.896 (0.793–1.036) | 155/183 258/194 165/159 200/165 160/131 |
| `grep -rc owner /wiki \| tail -1` | 0.667 | 0.947 (0.851–1.040) | 130/122 114/126 105/104 116/110 137/107 |
| `grep -rn owner /wiki \| tail -1` | 0.646 | 0.871 (0.795–0.945) | 132/120 129/97 109/108 139/112 110/101 |
| `sed -i 's/zqzq/zqzq/' /wiki/*/*.md` | 0.693 | 0.802 (0.646–0.943) | 307/161 197/193 182/174 188/156 168/137 |
| geometric mean | 0.767 | 0.915 | |

Output was identical in every pair (`local-workerd-pairs.jsonl`,
`cloudflare-pairs.jsonl`).

## What it says

- The direction holds: 0.915 overall, `sed -i` and `grep -rn` with
  intervals below 1, and no command with an interval above 1.
- The effect is diluted on 200 pages. A command costs 100–190 ms on
  Cloudflare against 4–16 ms locally, and most of that is fixed — the call
  into the Durable Object and setting up the shell — so a per-chunk or
  per-line saving is a smaller share than over 10,000 pages.
- `cat | grep -c` points the other way (1.079, interval 0.953–1.212) with
  five pairs in one session; it is unresolved, not a measured regression,
  and the 10,000-page local pairs measured it at 0.908 (#131).

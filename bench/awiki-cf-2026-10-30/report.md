# awiki on Cloudflare — 2,000 and 10,000 pages, 2026-10-30

`run.mjs` seeds a fresh instance of the agent evaluation Worker
(`eval.vfs.borca.ai`, version 1f552107, cf-vfs 433f737 with awiki 0.6.0) with
the S3 audit wiki at 2,000 pages (9.9 MB) and at 10,000 pages (49.7 MB, the
same generator), runs each step as one execution, and reads Worker time and
SQL cost from the execution log. One run per wiki (`run.log`, `results.json`).

| Step | 2,000 pages | | 10,000 pages | |
| --- | ---: | ---: | ---: | ---: |
| | Worker ms | statements | Worker ms | statements |
| `awiki lint`, first run | 5,579 | 6,024 | 23,437 | 30,038 |
| `awiki lint`, warm (3 runs) | 499–553 | 2,023 | 4,247–4,630 | 10,037 |
| `awiki graph`, pages nothing links to | 532 | 2,023 | 3,994 | 10,037 |
| `awiki links`, one page | 727 | 2,023 | 3,333 | 10,037 |
| `awiki lint` after one edit | 677 | 2,025 | 2,951 | 10,037 |
| grep, backlinks of one page | 1,867 | 4,011 | 10,250 | 20,035 |
| grep pipeline, inbound counts | 5,643 | 4,011 | failed: expansion work limit | 15,742 |
| `awiki lint` after 4 minutes idle | 4,969 | 6,024 | 22,714 | 30,038 |

- Warm runs cost one statement per page: the empty read that returns each
  page's token. At about 0.25–0.45 ms per statement on Cloudflare that is
  nearly all of the warm time (local Node: 30 ms for 2,000 pages).
- The first run reads and parses every page and is 23 s at 10,000 pages, close
  to the 30 s execution deadline. After four idle minutes the object had been
  evicted and the cache was gone.
- `awiki graph` answers the audit question about ten times faster than the
  grep pipeline at 2,000 pages; at 10,000 pages the pipeline exceeds the shell's
  expansion work limit.
- The step that picks a page to edit, `find wiki -name '*.md' | sort | head -1`,
  failed at 10,000 pages with "pathname expansion match limit exceeded":
  `find` stops at 10,000 matches. The edit did not happen, so the following
  lint is a warm run.
- The `graph -json` step failed in both runs: the cf-vfs `jq` profile refuses
  string interpolation (`"\(.name)"`).

The shell time column of the log read 0 throughout; Worker time is the
reliable measure here.

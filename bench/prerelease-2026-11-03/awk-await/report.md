# Small Cloudflare check of #133 before release, 2026-11-03

The same method as [the check of #131 and #132](../report.md): main before
#133 (e803715) bundled beside main after it (cef76af) in one SQL lab
deployment (5714023c), 200 pages of the S3 wiki, six commands, five
alternating pairs timed at the Worker, no warmup pair. The run took 13 s;
the lab object was destroyed and the clean lab redeployed (7e2f7411).

| Command | local workerd | Cloudflare (95% bootstrap) | Cloudflare pairs, before/after ms |
| --- | ---: | ---: | --- |
| `awk '{ print $1 }' /wiki/*/*.md \| wc -l` | 0.758 | 0.722 (0.595–0.877) | 147/119 106/79 88/49 104/59 66/68 |
| `awk 'FNR == 1' /wiki/*/*.md > /dev/null` | 0.637 | 0.801 (0.668–0.960) | 68/66 45/37 52/31 37/25 38/39 |
| `awk '/owner/ { n++ } END { print n }' /wiki/*/*.md` | 0.610 | 0.816 (0.687–0.934) | 66/56 50/30 37/33 39/31 40/40 |
| `wc -l /wiki/*/*.md \| tail -1` | 0.891 | 0.941 (0.832–1.033) | 36/38 35/26 29/27 23/24 32/31 |
| `cat /wiki/*/*.md \| wc -l` | 1.000 | 1.028 (0.877–1.220) | 41/40 34/29 27/31 25/35 28/24 |
| `cat /wiki/*/*.md \| tr a-z A-Z \| wc -c` | 0.972 | 0.758 (0.608–0.946) | 73/79 77/70 111/62 113/66 78/61 |
| geometric mean | 0.796 | 0.838 | |

Output was identical in every pair (`local-workerd-pairs.jsonl`,
`cloudflare-pairs.jsonl`).

The direction holds: the three awk commands and `cat | tr | wc -c` have
intervals below 1 on Cloudflare, and no command has one above it.
`cat | tr | wc -c` gains more there than locally (0.758 against 0.972), as
the calibration expects for runtime crossings such as the abort listener
per chunk this change removed. `cat | wc -l` is unresolved in both.

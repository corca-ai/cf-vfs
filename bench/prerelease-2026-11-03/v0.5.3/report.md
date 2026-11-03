# Small Cloudflare check before v0.5.3, 2026-11-03

The same method as [the check before v0.5.2](../report.md): v0.5.2 (2ce15c9)
bundled beside main with #135, #138, #139 and #140 (43c0f6a) in one SQL lab
deployment (8ca9ea73), 200 pages of the S3 wiki, six commands, five
alternating pairs timed at the Worker, no warmup pair. The run took 40 s
and was run once; the lab object was destroyed and the clean lab redeployed
(698088fe). The local column is the same five pairs on local workerd.

| Command | Change | local workerd | Cloudflare (95% bootstrap) | Cloudflare pairs, before/after ms |
| --- | --- | ---: | ---: | --- |
| `sed 's/owner/OWNER/' /wiki/*/*.md \| wc -l` | #135 | 0.575 | 0.771 (0.709–0.840) | 115/77 67/54 95/73 73/54 110/98 |
| `cat /wiki/*/*.md \| sed 's/x/y/' \| wc -l` | #135, #138 | 0.612 | 0.815 (0.558–1.191) | 165/67 68/88 107/143 78/50 85/68 |
| `cat /wiki/*/*.md \| grep -c owner` | #138 | 0.772 | 0.944 (0.873–1.020) | 41/44 48/46 41/34 41/36 38/38 |
| `cat /wiki/*/*.md \| awk '{ print $1 }' \| wc -l` | #138 | 0.918 | 0.902 (0.771–1.056) | 165/124 106/92 131/138 106/79 90/105 |
| `jq -R length /wiki/*/*.md \| wc -l` | #140 | 0.833 | 0.822 (0.745–0.930) | 147/112 164/167 154/109 132/114 147/116 |
| `sort /wiki/*/*.md \| tail -1` | #140 | 0.715 | 0.826 (0.551–1.127) | 121/129 151/62 100/69 94/95 108/136 |
| geometric mean | | 0.728 | 0.845 | |

Output was identical in every pair (`local-workerd-pairs.jsonl`,
`cloudflare-pairs.jsonl`).

The direction holds: every ratio is below 1 on Cloudflare, `sed` over files
and `jq` with intervals below 1, and no command with an interval above 1.
The piped `sed` and `sort` intervals are wide with five pairs; as before,
200 pages dilute a per-line saving behind the fixed cost of the call and the
shell. #139 changes what sed charges to expansion work, not its speed; its
outcomes were checked locally on 10,000 pages (`../../sed-output-work-2026-11-03/`).

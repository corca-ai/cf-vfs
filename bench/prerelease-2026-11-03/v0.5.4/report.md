# Small Cloudflare check before v0.5.4, 2026-11-03

The same method as [the check before v0.5.3](../v0.5.3/report.md): v0.5.3
(1783568) bundled beside main with #142, #143 and #144 (e57924c) in one SQL
lab deployment (39e3933e), 200 pages of the S3 wiki, six commands, five
alternating pairs timed at the Worker, no warmup pair. The run took 42 s
and was run once; the lab object was destroyed and the clean lab redeployed
(fc73de00). The local column is the same five pairs on local workerd.

| Command | Change | local workerd | Cloudflare (95% bootstrap) | Cloudflare pairs, before/after ms |
| --- | --- | ---: | ---: | --- |
| `awk '{ gsub(/owner/, "OWNER"); print }' /wiki/*/*.md \| wc -l` | #142 | 0.931 | 0.928 (0.873–0.994) | 204/177 193/204 157/147 112/95 92/87 |
| `sed '$!N;P;D' /wiki/*/*.md \| wc -l` | #143 | 0.922 | 0.970 (0.809–1.169) | 132/159 149/109 69/71 79/62 67/81 |
| `cut -c1-8 /wiki/*/*.md \| wc -l` | #144 | 0.712 | 0.750 (0.648–0.855) | 95/77 80/74 92/67 109/62 102/78 |
| `uniq -c /wiki/*/*.md \| tail -1` | #144 | 0.833 | 0.951 (0.856–1.053) | 130/138 87/82 138/124 102/80 77/85 |
| `nl /wiki/*/*.md \| tail -1` | #144 | 0.653 | 0.691 (0.632–0.740) | 87/60 63/48 66/47 81/47 62/45 |
| geometric mean of the five | | 0.803 | 0.876 | |

A sixth command checks an outcome, not a time:
`sed -n ':a;N;$!ba;s/\n/ /g;p' /wiki/legal/*.md | wc -c` stopped at the
expansion-work limit with v0.5.3 in every run, locally and on Cloudflare,
and printed 87,629 with main (#143).

Output was otherwise identical in every pair (`local-workerd-pairs.jsonl`,
`cloudflare-pairs.jsonl`).

The direction holds: `cut` and `nl` have intervals below 1 on Cloudflare,
as locally, the awk edit nearly so, and no command has an interval above 1.
#142 and #143 change what the limits admit, not speed; their larger outcomes
were checked locally on 10,000 pages (`../../awk-build-work-2026-11-03/`,
`../../sed-join-scan-2026-11-03/`).

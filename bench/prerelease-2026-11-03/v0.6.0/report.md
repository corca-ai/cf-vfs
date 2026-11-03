# Small Cloudflare check before v0.6.0, 2026-11-03

The same method as [the check before v0.5.4](../v0.5.4/report.md): v0.5.4
(c810201) bundled beside main with #148, #150 and #151 (b4fedfd) in one SQL
lab deployment (34011a49), 200 pages of the S3 wiki, six commands, five
alternating pairs timed at the Worker, no warmup pair. The run took 74 s and
was run once; the lab object was destroyed and the clean lab redeployed
(d185869c). The local column is the same five pairs on local workerd.

| Command | Change | local workerd | Cloudflare (95% bootstrap) | Cloudflare pairs, before/after ms |
| --- | --- | ---: | ---: | --- |
| `grep -cE 'owner\|team\|budget' /wiki/*/*.md \| tail -1` | #148 regex steps | 1.021 | 1.201 (1.013–1.420) | 326/488 243/364 308/283 192/203 230/264 |
| `for f in /wiki/*/*.md; do head -1 "$f"; done \| wc -l` | #150 work, pause | 1.134 | 1.036 (0.857–1.220) | 115/147 124/128 158/113 98/98 132/167 |
| `awk '{ $3 = ""; $4 = ""; print }' /wiki/*/*.md \| wc -l` | #151 allowance | 1.033 | 1.150 (0.947–1.460) | 222/208 185/194 134/241 158/198 165/150 |
| `fold -w 60 /wiki/*/*.md \| wc -l` | #151 fold | 0.529 | 0.602 (0.583–0.622) | 157/91 100/61 113/65 100/64 92/56 |
| `sort /wiki/*/*.md \| uniq -c \| wc -l` | #150 comparisons | 1.010 | 0.870 (0.770–0.959) | 144/143 156/112 144/123 142/140 163/135 |
| `cat /wiki/*/*.md \| sed 's/x/y/' \| cat \| wc -c` | #148, #150 pipes | 0.964 | 0.913 (0.802–1.126) | 100/84 116/90 135/116 138/189 70/58 |
| geometric mean | | 0.922 | 0.939 | |

Output was identical in every pair (`local-workerd-pairs.jsonl`,
`cloudflare-pairs.jsonl`).

`fold` gains on Cloudflare as locally. `grep -E` measured 1.201 with an
interval above 1, the first pair cold (326/488) and the rest 0.92–1.50; awk's
column edit 1.150 with an interval that includes 1. Per the protocol the
Cloudflare run was not repeated. On local workerd over the 10,000-page wiki
with ten pairs (`local-workerd-pairs-10k.jsonl`) the same commands measured
`grep -cE 'owner|team|budget' /wiki/sales/*.md` 0.984 (0.977–0.991), `grep -c`
0.941, the awk column edit 1.006 (0.998–1.012) and `awk '{ print $1 }'`
1.000. The Cloudflare `grep -E` result is unresolved: the regex meter adds a
callback per search, which local workerd measures at no cost; a check at a
later release should include it again.

#150 and #151 mostly change what the limits admit; their larger outcomes were
checked locally on 10,000 pages (`../../five-limits-2026-11-03/`,
`../../awk-rebuild-fold-2026-11-03/`, `../../limit-semantics-2026-11-03/`).

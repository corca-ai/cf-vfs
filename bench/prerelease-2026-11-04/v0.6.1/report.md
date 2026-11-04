# Small Cloudflare check before v0.6.1, 2026-11-04

The same method as [the check before v0.6.0](../../prerelease-2026-11-03/v0.6.0/report.md):
v0.6.0 bundled beside main with #154 (e8501b9) in one SQL lab deployment
(8f2f7e0c), 200 pages of the S3 wiki, six commands, five alternating pairs
timed at the Worker, no warmup pair. The run took 31 s and was run once; the
lab object was destroyed and the clean lab redeployed (e7c6622b). The local
column is the same five pairs on local workerd.

| Command | Change | local workerd | Cloudflare (95% bootstrap) | Cloudflare pairs, before/after ms |
| --- | --- | ---: | ---: | --- |
| `grep -oh "[a-z]*" /wiki/*/*.md \| wc -l` | #154 | 0.941 | 0.866 (0.651–1.120) | 509/434 725/376 459/403 472/449 436/574 |
| `grep -ohE "\[\[[^]]+\]\]" /wiki/*/*.md \| wc -l` | #154 | 0.878 | 0.864 (0.675–1.090) | 144/80 54/69 75/69 113/94 88/78 |
| `grep -o owner /wiki/*/*.md \| wc -l` | #154 | 1.013 | 1.015 (0.908–1.169) | 57/63 38/35 37/34 37/33 31/40 |
| `find /wiki -name "*.md" \| xargs wc -l \| tail -1` | #154 | 0.903 | 0.829 (0.657–1.047) | 54/68 60/37 52/49 47/42 70/42 |
| `grep -cE "owner\|team\|budget" /wiki/*/*.md \| tail -1` | none | 0.995 | 1.266 (1.016–1.653) | 165/183 180/202 201/178 147/223 142/276 |
| `grep -c owner /wiki/*/*.md \| tail -1` | none | 1.046 | 1.050 (0.808–1.354) | 36/49 58/44 42/58 62/43 31/40 |

Output was identical in every pair (`local-workerd-pairs.jsonl`,
`cloudflare-pairs.jsonl`).

The `grep -o` and `xargs` commands lean the way they do locally, with intervals
that include 1, as five pairs of commands this short allow.

`grep -cE` was included for the 1.201 left unresolved before v0.6.0. It measured
1.266 here, although #154 does not change the code it runs: a count selects
lines through `regex.test` and writes nothing, and both arms execute the same
source for that path. Per the protocol the run was not repeated. So a ratio of
this size can arise on Cloudflare without any change to the measured path,
which weakens the case that the regex meter caused the earlier 1.201, without
settling what does cause it.

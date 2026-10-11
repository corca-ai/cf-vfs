# Completed capability experiments

Adopted optional statMany and opt-in FsMetadataIndex after local and actual CF
comparisons. Frozen graph 28720507900c8a69fce5b5e5e6ae9b6a4f891e2054fff3b7ed535c859a6728b2.
Full CF ten-pair primary score: demo +1.84%, unbound +5.41%; both intervals
below one. Every workload preserves native reads and writes. SQL statements
fall 7.62% / 12.06%. Four timing flags did not reproduce in independent
20-pair complete-group repeats; original flags remain in the report.
Node 1988 (four workers), Workers 158, POSIX 46/46 and all 12 unchanged bundle
budgets pass. Default unbounded local Node concurrency hit an existing timeout.
Index initial/feed write costs and one-owner restrictions are explicit.
Private evaluation Workers are being removed; public rollout remains pending.
See ../capability-extensions-2026-10-11.md and README.md for complete evidence.

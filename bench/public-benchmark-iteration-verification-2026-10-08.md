# Repeated CF evaluation verification — 2026-10-08

Deployment: `eb8219b2-9176-4892-bbe9-331bf6605f22`.

The authenticated CLI started two complete real production runs, d814d299-bc98-43d6-94cd-20050835262a
and cd8d27a2-3c66-450b-b0ac-afa7d0ad0a1d, 105952 ms apart. Both completed
88 rows and 18,096 assertions. The second run bypassed the public ten-minute
freshness rule. Public and developer requests during it returned 202/reused
and retained the previous result. A public POST after completion returned the
same run ID and mtime. Unauthenticated developer and private benchmark POSTs
returned 401. Full verification passed (1,842 Node + 125 workerd tests).

Raw data: [first](public-benchmark-iteration-2026-10-08.json),
[repeat](public-benchmark-iteration-repeat-2026-10-08.json).
These runs verify repeatable evaluation plumbing; no new library speed gain is
claimed. Timing remains three-sample RPC wall time with production variability.

See [workflow](../demo/README.md#repeated-production-performance-evaluation).

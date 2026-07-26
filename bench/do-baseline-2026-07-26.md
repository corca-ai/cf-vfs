# Durable Object structural-cost baseline — 2026-07-26

Environment: Apple M2, macOS 27.0, arm64, Node v24.6.0, workerd through
`@cloudflare/vitest-pool-workers`. Run with `npm run bench:do`. This records
what removing redundant reads changed; latency, density, and pricing
discussion stay in [2026-07-24](do-baseline-2026-07-24.md), which this does not
replace.

The `before` column is `origin/main` at `d2e09ee`, measured with the same
benchmark file so the two columns differ only in the code under test.

| Operation | before | current | change |
| --- | ---: | ---: | ---: |
| create 512 small BLOBs — statements | 6,144 | 5,120 | −17% |
| create 512 small BLOBs — rows read | 6,144 | 4,608 | −25% |
| random-read 512 small BLOBs — statements | 1,024 | 1,024 | — |
| random-read 512 small BLOBs — rows read | 2,047 | 2,047 | — |
| 8-byte overwrite — statements | 13 | 9 | −31% |
| 8-byte overwrite — rows read | 21 | 16 | −24% |
| subtree copy — statements | 11 | 9 | −18% |
| subtree move — statements | 8 | 8 | — |
| subtree remove — statements | 10 | 10 | — |
| `stat()` in a populated namespace | 1 stmt / 2 rows | 1 stmt / 2 rows | — |

Reads were already close to minimal, which is why the read rows do not move:
the work removed was a write asking again for what it had just been told.

## What changed

**A row already carries its mutation token.** The entry query joins
`vfs_path_versions` and builds `mutationToken` from that column, so a caller
holding a row holds the token. `writeFile` read it separately anyway, before
and inside its transaction.

**`vfs_usage` is a singleton only the running transaction can change.** Both
capacity checks a write makes, and the total handed to an observer, now come
from one read and the deltas applied to it.

**The parent walk keeps the row it stopped on**, rather than resolving that
path again to confirm it is a directory.

What did not change is the pair of reads around the body stream. Between them
the caller's body is still arriving, another request to the same object can
run, and re-reading is the guard rather than a repeat of it.

## A note on the benchmark itself

The subtree comparison previously ran both sizes through one filesystem
instance. The symlink count is cached per instance and invalidated by any
mutation, so the work done for the first size decided whether the second paid
for a recount — a constant, but one that landed asymmetrically and made the
comparison partly about cache state. Each size now measures through its own
instance over the same storage. The recorded move cost moves 7 → 8 for that
reason alone; it is unchanged by the code in this baseline, and `origin/main`
measures 8 under the same benchmark.

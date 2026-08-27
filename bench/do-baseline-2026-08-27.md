# Durable Object VFS write-path baseline — 2026-08-27

Environment: Apple M4, macOS 26.5.1, arm64, Node v24.18.0, workerd through
`@cloudflare/vitest-pool-workers` 0.18.6. Run with `npm run bench:do`.

The `before` column is `origin/main` at `3e950d4`. Both columns use the same
benchmark scenarios. Counted SQL work is the regression signal; local elapsed
time is included only as supporting evidence because workerd timing is noisy.

| Operation | before | current | change |
| --- | ---: | ---: | ---: |
| create 512 root-level 8–12 KiB files — statements | 5,120 | 3,584 | −30% |
| create 512 root-level 8–12 KiB files — rows read | 4,608 | 3,584 | −22% |
| create 512 root-level 8–12 KiB files — rows written | 3,072 | 3,072 | — |
| 1 MiB same-size overwrite + snapshot — rows read | 30 | 26 | −13% |
| 1 MiB same-size overwrite + snapshot — rows written | 11 | 7 | −36% |
| 8-byte same-size overwrite — statements | 8 | 7 | −13% |
| 8-byte same-size overwrite — rows read | 14 | 13 | −7% |
| 8-byte same-size overwrite — rows written | 5 | 4 | −20% |

Across three independent workerd runs, median small-file write time moved from
68 ms to 44 ms. The unchanged random-read control also moved from 52 ms to
23 ms, however, so the elapsed difference cannot be attributed entirely to
this patch and is deliberately not presented as a percentage improvement.
The exact cursor counters above are the evidence used to accept the changes.

The 1/33/34-chunk creation boundary moved from 10/10/11 statements to
7/7/8. The extra statement still appears only when a write crosses the
33-chunk, 99-bound-parameter batch boundary.

## Changes retained

**One absent-path lookup now carries both state and token.** Before buffering a
stream, and again inside the commit transaction, a create used one query to
find no entry and a second query to find no tombstone. Starting from
`vfs_path_versions` and left-joining the entry makes each check one indexed
statement while preserving removed-path tokens and the no-row result for a
path never used.

**Trusted root-level creation no longer reads the root row.** The schema creates
`/` before public operations and the API cannot remove or replace it. A trusted
create does not consume root ownership or mode, so that read established no
additional invariant. Credential-bound and nested creation still inspect the
real parent.

**Overwrites retain chunk rows.** The existing UPSERT already replaces every
chunk position present in the new body. Same-size and growing writes therefore
skip the old full-body DELETE. Shrinking writes delete only indexes at or past
the new chunk count, and a structural test covers same-size, growth, shrink,
and the resulting bytes.

An additional candidate combined the usage quota SELECT and UPDATE into one
conditional UPDATE. It reduced statement count by one but did not reduce
workerd rows or measured latency, while making quota failure handling more
complex, so it was not retained.

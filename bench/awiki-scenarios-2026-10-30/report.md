# Agent tasks with and without awiki — scripted upper bound, 2026-10-30

Before running agents with awiki available, this measures the most awiki could
change on the S1 and S3 tasks: each task solved by a script with only the
utilities the agents had, and by a script that hands awiki every part it can
do. No agent ran; the scripts are hand-written and graded against the same
expected end state as the agent runs.

- `fixtures.py` rebuilds both wikis from the seeded generators the agent runs
  used; S3 is byte-identical to `../regex-prefix-2026-10-29/local/s3-files.json.gz`.
- `solutions.mjs` holds the scripts, one string per execution.
- `run.mjs ROOT FIXTURES 5` runs each solution five times on a fresh local
  SQLite filesystem with default limits, then compares the whole wiki tree with
  the expected one (`run.log`, `results.json`).

## Results (median of 5, Apple M5 Max, Node v24.22.1)

| Task | Solution | Executions | Script bytes | Time | SQL statements | Correct |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| S1 (30 pages) | shell | 3 | 1,546 | 18 ms | 813 | yes |
| S1 | awiki | 3 | 1,273 | 7 ms | 509 | yes |
| S3 (2,000 pages, 9.9 MB) | shell | 2 | 1,153 | 612 ms | 14,123 | yes |
| S3 | awiki `links` per page, first 100 pages | 1 | 376 | 3,201 ms | 206,542 | no (partial by design) |

S1 with awiki: `awiki rename -r` replaces the rename and link rewriting, and
`awiki wanted -r -sources 0` reformatted with awk replaces the broken-link scan.
The title and heading still need `sed`: awiki updates a title only when it
equals the file name, and never the heading. The tag index is outside awiki,
so that step is the same script.

S3 has no awiki route. awiki does not report inbound counts for every page,
its `lint` orphans (pages with no links in either direction) are not the
task's orphans (pages no other page links to), and owners are front matter it
does not read. The only route is one `awiki links` per page: 32 ms and about
2,065 statements each, since every run checks every page's token. Extrapolated
to 2,000 pages that is about 64 s and 4.1 million statements. Each run also
charges the wiki's 9.9 MB to `maxReadBytes`, so one execution fits at most
about 108 runs and the task needs at least 19 executions.

## Context from the agent runs (round 8, 2026-10-29)

| Task | Executions | Wall time | Worker time per execution |
| --- | ---: | ---: | --- |
| S1 | 11 | 83 s | — |
| S3 | 19 | 284 s | median 4.9 s, max 31.5 s |

The scripted shell solutions do the same work in 18 ms and 612 ms. The agents'
cost was exploration, verification and slower scripts (whole-wiki regex
scans), not missing capability, and on these two tasks awiki removes little of
it: one simpler step in S1, nothing in S3.

## Conclusion

Mentioning awiki to agents on the current scenarios would mostly measure
whether they reach for a tool that does not fit. A difference would show on
tasks in awiki's domain: graph health (orphans, islands, link-only lines),
wanted pages, renames across a large wiki, near-duplicates. For audit tasks
like S3, awiki would need a bulk, machine-readable view of the link graph
(for example inbound counts for every page in one run), which it does not have.

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
| 8-byte overwrite — statements | 13 | 8 | −38% |
| 8-byte overwrite — rows read | 21 | 14 | −33% |
| 1 MiB overwrite — rows read | 33 | 28 | −15% |
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

**A write over an entry that is already there does not check its parents.**
The entry is proof of them: nothing removes or replaces a directory while a
child remains, and every route that could reach the parent must delete the
child first, which bumps its version and so fails the token the write already
compares. `touch` reaches the same conclusion by returning early. Only an
overwrite gains — a create still walks.

Review found that invariant was not actually true before this change, for a
reason unrelated to reading: `ensureParents` accepted a link that resolved to
a directory as a parent, so a child could be stored naming the link, and the
link could then be repointed. Reachable on `origin/main` by replacing a
directory with a link while a body is still arriving. A link is now refused
there, which is what makes the sentence above hold.

What did not change is the pair of reads around the body stream. Between them
the caller's body is still arriving, another request to the same object can
run, and re-reading is the guard rather than a repeat of it.

## The recorded costs had drifted, and this reads them again

`npm run bench:do` was already failing on `origin/main`: four of its seven
checks, because the Performance workflow runs on a weekly schedule rather than
on a pull request, so nothing compared them for fifty-six commits. What main
actually measured against what it had recorded:

| Guard | recorded | main measured |
| --- | ---: | ---: |
| create 512 files — rows read | 5,632 | 6,144 |
| 1 MiB overwrite — rows read | ≤ 31 | 33 |
| subtree statements | `{11, 7, 10}` | `{12, 8, 10}` |
| 8-byte overwrite — rows read | 19 | 21 |

So the `before` column above is what main *measures*, not what it had written
down — a diff of the recorded numbers alone would read this change as smaller
than it is on two rows and would hide that the 1 MiB overwrite guard goes from
red to green. Every `before` cell was taken by running the benchmark against
main with this benchmark file.

## A note on the benchmark itself

The subtree comparison ran both sizes through one filesystem instance. The
symlink count is cached per instance and invalidated by any mutation, so the
work done for the first size decided whether the second paid for a recount —
a constant, but one that landed asymmetrically. That is why main fails its own
`large === small` assertion at 12 against 11: the guard was reporting cache
state, not how subtree cost answers entry count. Each size now measures
through its own instance over the same storage, and the assertion holds again.

The refactor moves the measured copy cost by one — 12 → 11 on main, 10 → 9
here — because a cold instance is what each size now pays. `move` is 8 on both
branches under either benchmark; the recorded 7 was simply stale, and this
change does not affect it.

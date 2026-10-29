# Literal-prefix regex prefilter: retained on a targeted gain

Status: retained by the user's explicit decision on 2026-10-29. Candidate
`02d96c7` makes a compiled POSIX regular expression skip to the next
occurrence of its literal prefix with `indexOf` while no match thread is alive.
No suite-wide improvement was established, so retention rests on the targeted
gain and the absence of any regression; `acceptance.json` records this.

## Why the suites cannot show it

The 190 public workloads run files, Git and coding operations and never
compile a regular expression. The agent task runs `sed 's/state[0-9]*/…/g'`
and `grep -c` over 20 small files, where Git dominates the time. This was the
first change measured under
[scoped Cloudflare evidence](../../docs/performance.md#scope-the-cloudflare-evidence-to-the-change):
three task runs per version and one candidate full-suite control.

## Evidence

| Measurement | Result |
| --- | --- |
| Targeted: S3 wiki `grep -rhoE '\[\[[^]]*\]\]'`, 2,000 pages, local | 489 → 147 ms (median of five) |
| Same, fixed string and BRE without a prefix | 73 → 75 ms, 81 → 78 ms |
| Local full paired plan, four sessions (ORDER_OFFSET balanced) | overall 1.0010, 1.0012, 1.0022, 1.0029 |
| Local A/A | 0.9946 |
| Local recheck of the three >5% pooled workloads, 12 pairs, two sessions | 0.9922, 0.9967 |
| CF agent task, 3 runs per version, previous commit = 100 | 104.17 [87.77, 123.62], uncertain |
| CF task SQL, every replay on both versions | 3,560 statements, 8,281 rows read, 520 written |
| CF full control: candidate vs mean of two baseline runs | geomean 1.0013; 71 rows >5% slower |
| CF full A/A: baseline run 2 vs run 1 | geomean 1.0139; 68 rows >5% slower |

A single full run cannot resolve one workload: two runs of the same code
differ by more than 5% on about a third of the rows. The control run is
indistinguishable from that A/A spread, which is why the escalation rule
compares a control run with the baseline A/A rather than with a fixed 5%.

## Runs and identities

Baseline deployment `d32d8651-bd3c-45e8-816f-0f069b63e93b`, build
`f3f70daf…ada7`, commit `2a95471`: full runs `da755d82`, `096e01da` (the
planned third run was stopped before it began when the protocol was scoped);
task runs `05a47509`, `3e60bce3`, `ad744409`.

Candidate deployment `12333038-6dea-4606-8ecb-5505f0779ce8`, commit
`02d96c7`: task runs `8f8d6db2`, `3031d441`, `64508f05`; full control
`db1d4af9`. Both were deployed with `cf deploy` to the same Worker, bindings
and DO names. Median RPC pings were 13–14 ms on both arms of the full runs
and 24–29 ms in the task runs, with no shift between versions. No live logging was
attached. Full suites verified 212,268 checks and task suites 28,028.

`cf/` holds every snapshot, claim, client log and assessment; `local/` holds
the paired sessions, the targeted benchmark, its S3 fixture and the scripts.

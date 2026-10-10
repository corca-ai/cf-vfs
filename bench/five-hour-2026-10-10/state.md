# Five-hour performance run

Start: 2026-10-10 10:39:23 UTC. Optimization deadline: 2026-10-10 15:39:23 UTC.
Baseline commit: a03a31d (adopted library 08b8e0b).
User prioritizes full-suite geometric mean; individual latency tradeoffs must
remain disclosed. POSIX/API behavior and SQL-cost/bundle gates remain required.
Local success precedes actual CF verification and adoption. No subagents.

Initial state: clean worktree. Prior goal turn only announced work (no progress);
this continuation revalidated state and begins immutable baseline preparation.

10:46 UTC: Local A/A demo full10 overall0.9982 CI[0.9943,1.0042], zero confirmed
latency flags. Identical sources have two returned-row differences (+3,+2),
with identical statement counts; returned rows are not billed reads. A targeted
query-level A/A diagnostic is prepared. Lazy Map clearing full10 overall1.0006
CI[0.9970,1.0070]: neutral, rejected without CF adoption testing. Patch retained.
Fresh public baseline run1abe8334-8847-479b-adff-a53a95399963 verified190/60648.

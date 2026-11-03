# Five shell limits instead of twenty-seven, 2026-11-03

0.5 had twenty-seven shell limits. Reviewing what each guards on Cloudflare
(DO duration $12.50 per million GB-s, rows read $0.001 per million, rows
written $1.00 per million, 128 MB per isolate, 30 s of CPU per request)
found that they protect five things: wall-clock time, synchronous CPU — which
the deadline cannot stop, because `Date.now()` is frozen between I/O and
inline SQLite reads never yield — memory held at once, stack depth, and
rows written. Several of them stopped ordinary agent work without guarding
any of these: 20,000 commands, 64 MiB of I/O, 10,000 glob matches.

## Change

- `ShellLimits` is `deadlineMs` (30 s), `maxWork` (10,000,000), `maxMemoryBytes`
  (16 MiB), `maxDepth` (64) and `maxRowsWritten` (50,000).
- `maxWork` counts synchronous work in units of about a microsecond of local
  workerd CPU (`../limits-calibration-2026-11-03/report.md`): a shell step 2,
  a command 4 more, an expansion unit 0.25, a byte read, moved, written or
  discarded 0.02, a regular-expression step 0.01, a `sort` comparison 0.025.
  `cp` charges the bytes it copies. A refusal names its three largest
  consumers, and the `shell.limit` event carries them as `breakdown`.
- Every narrower cap is derived (`deriveShellLimits`): structure caps scale
  with `maxMemoryBytes` and equal 0.5's at the default, except glob matches and
  expansion fields, raised to 65,536; depth caps scale with `maxDepth`.
- Mutations charge `maxRowsWritten`, four rows an entry and a row for each
  further 256 KiB chunk written or copied.
- 0.5's names are accepted, deprecated, as the derived caps they named; the
  frozen benchmark workload passes `maxTotalIoBytes` and is hash-pinned, so
  refusing them would have restarted the public series. Other names are
  refused. A 0.5 policy's `maxMutations` is taken at four rows each.
- Every 32,768 commands or loop iterations the shell yields to the event loop
  (`ExecutionBudget.pause`). A loop of inline work only ever queues
  microtasks, so neither the deadline's timer nor a cancellation could run:
  with the 20,000-command limit gone, an aborted `while :; do :; done` ran
  4.3 s on Node until `maxWork` stopped it; it now stops within a few hundred milliseconds. At 8,192 it stopped in 55 ms,
  but each turn costs about 1.5 ms on local workerd and a loop of 8,000
  iterations measured 1.076 (`local-workerd-pairs-pause.jsonl`); at 32,768 a
  turn comes every 100–250 ms of loop work, about 1%, and that loop reaches
  none.
- The public demo runs at a fortieth of the default work (about a quarter
  second, what its 0.5 expansion limit allowed), 2 MiB of memory, depth 32 and
  2,000 rows; eval's scaled wikis scale work, memory, rows and the deadline.

## Results

Local workerd, main (c461c72) beside this branch, ten alternating pairs over
the 10,000-page wiki (`local-workerd-pairs.jsonl`), outputs identical:

| Command | ratio (95% bootstrap) |
| --- | ---: |
| `grep -c owner /wiki/*/*.md \| tail -1` | 1.004 (0.989–1.020) |
| `cat /wiki/sales/*.md \| wc -l` | 1.007 (0.985–1.030) |
| `sed 's/owner/OWNER/' /wiki/legal/*.md \| wc -l` | 1.002 (0.978–1.030) |
| `awk '{ print $1 }' /wiki/legal/*.md \| wc -l` | 1.017 (0.997–1.041) |
| `sort /wiki/sales/*.md \| uniq -c \| wc -l` | 1.022 (1.006–1.037) |
| `for f in /wiki/legal/topic-0*.md; do head -1 "$f"; done \| wc -l` | 1.026 (0.758–1.403), 5 ms |
| `i=0; while [ $i -lt 5000 ]; do i=$((i+1)); done` | 1.021 (0.969–1.078) |
| `find /wiki -name "*.md" \| wc -l` | 1.009 (0.986–1.032) |
| geometric mean | 1.014 |

Charging every kind of work to one counter costs about 1.4%; `sort`, which
now counts its comparisons, 2.2%.

What the agent can now do in one execution, on Node over the 10,000-page
wiki: `for f in /wiki/*/*.md; do t=$(head -1 "$f"); echo "$f $t"; done`
over all 8,055 pages in 420 ms (0.5 stopped at 6,666 with "shell command
limit exceeded"), `find /wiki -name "*.md" | while read f; do head -1 "$f";
done` over all 10,000 pages in 406 ms, 50,000 shell-loop iterations in
331 ms (0.5: under 10,000), and `ls /wiki/*/*`, a glob of 10,004 matches
(0.5's cap was 10,000). What stops sooner: a single execution reading more than
about 500 MB (0.5 admitted 1 GiB of reads, bounded only by the deadline in
time).

Full local suite (`bench:local:paired`, `local-group-v1`, full plan, four
sessions with `ORDER_OFFSET` 0, 1, 0, 1; `local-paired-s1..4.json`,
`../summarize-local-pairs.mjs`): overall 0.998, families 0.992–1.007. Fourteen
workloads measured above 5%; the largest, `git/diff/1000` (1.201) and
`git/commit/1000` (1.193), came from one session at 2.04 and 2.05, and nine of
the fourteen are in the `git` family, which calls isomorphic-git directly and
runs no shell. Twelve pairs in two sessions over their seven groups
(`local-paired-recheck-o0/1.json`): overall 1.002, families 0.997–1.009; none
of the fourteen stayed above 5%, and a different seven rose to 1.053–1.091,
four of them in the `git` family.

## Reviews

Two independent reviews. One measured, with a frozen clock, what the first
weights let commands do per unit and found nine charging far less than their
CPU (`od` to `/dev/null` 39 µs a unit, `sort -n` 13.7, `tr` 9.8, a loop copying
an 8 MB file 330 µs), and rows of large files undercounted about 7.5×; the byte
cost, output charging, sort comparisons, copy bytes and chunk rows above are
its fixes. Shell loops, `awk`, `sed`, `grep`, `cut`, regular expressions and
warm `git status` were within or under a microsecond a unit. The other found
`test:limits` running every case under the default deadline (two `limits`
keys), a 0.5 `policy.maxMutations` silently ignored, prototype names such as
`toString` passing the name check, docs overstating what legacy names keep,
and the demo far looser than before at a tenth of the default work; all are
fixed. Its suggestion that regular-expression steps were overcharged eightfold
rested on the wrong meter rate for the calibration counts; timing the matcher
alone gave 5–10 ns a step, which the 25 steps a unit match.

## Bundle size

Four presets went over their budgets and were raised to their measured size
rounded up to 128 bytes: shell 264,064 (+5,120), interactive 273,792 (+4,992), default-registry 653,952 (+5,248), linux-profile 865,536 (+5,248). Most of it is `budget.ts`: the
derived caps, the work breakdown and the legacy names.

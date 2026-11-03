# Work costs for `maxWork`, 2026-11-03

`maxWork` replaces 0.5's steps, commands, loop iterations, expansion work,
read bytes and total I/O with one count of synchronous work. Its unit should
be about the same CPU whatever the work is, so each kind was measured.

Method: the scripts in `scripts.json`, each dominated by one kind of work,
ran over the 10,000-page S3 wiki. `count.mjs` counted on Node what each charged
to every budget class (`node-counts.json`, 0.5.4 plus #148's semantics); the
SQL lab on local workerd timed each, median of seven
(`local-workerd-ms.json`).

| Script | Dominant charge | Local workerd | Cost per unit |
| --- | --- | ---: | ---: |
| `while [ $i -lt 9000 ]` arithmetic loop | 45,006 steps, 18,003 commands | 79 ms | ≈ 1.5 µs a step with its share |
| loop of three `true` | 38,506 steps, 17,503 commands | 66 ms | ≈ 3.8 µs a command |
| `cat /wiki/*/*.md > /dev/null` | 40.1 MB read | 149 ms | ≈ 3.7 ns a byte |
| `cat sales legal \| cat \| cat \| cat` | 59.8 MB through pipes | 46 ms | ≈ 0.6 ns a byte |
| 16-branch `grep -cE` | 441,708 expansion units (8 steps each, the first meter's rate) | 35 ms | ≈ 10 ns a step |
| `sed 's/e/E/g'` over sales | 723,442 expansion units, 5.2 MB read | 170 ms | ≈ 0.2 µs an expansion unit |
| awk string doubling | 8,388,868 expansion units | 2 ms | ≈ 0.0002 µs an expansion unit |
| `grep -c owner` over the wiki | 40.1 MB read | 204 ms | ≈ 5 ns a byte |

An expansion unit's cost spans three orders of magnitude, from a V8 rope join
to a `sed` per-match step, so the costs chosen are at the high end of each
kind, making the unit about a microsecond or less:

| Kind | `maxWork` units |
| --- | ---: |
| shell step | 2 |
| command (beyond its step) | 4 |
| expansion unit | 0.25 |
| byte read from a file body | 0.02 |
| byte through a pipe, standard input, a substitution, a file or `/dev/null` | 0.02 |
| regular-expression step | 0.01 (25 to an expansion unit) |
| `sort` comparison | 0.025 (10 to an expansion unit) |

A review measured, with a frozen clock on Node, what the first weights (a
read byte 0.005, a moved byte 0.002, no charge for written output, sort
comparisons or a copy's bytes) let commands do per unit: `od` to `/dev/null`
39 µs, `sort -n` 13.7, `tr` 9.8, `fold` 5.5, `wc` 4.6, `sort` 3.7, `base64`
3.4, `md5sum` 3.3, and a loop copying an 8 MB file 330 µs, where a unit should
be about one. A byte is what such commands do their work over, so a byte read
or moved is now 0.02 — 20 ns, which covers `tr`, `wc`, `fold`, `base64` and
`md5sum` — output written to a file or `/dev/null` is charged as moved, which
covers `od`'s threefold output, `sort` charges its comparisons, and `cp` the
bytes it copies. Shell loops cost 0.14–0.26 µs a unit and `awk`, `sed`, `grep`
and `cut` 0.1–1.45.

At 10,000,000 units the default admits about ten seconds of local workerd CPU
in any mix, under Cloudflare's 30-second limit per request even where Workers
is slower: about five million shell steps, 500 MB read or moved, or a billion
matcher steps. Timing the matcher alone on Node (`regex-step-cost.mjs` in the
review of #148's successor) gave 5.2 ns a step for 16 branches, 7.1 for 120,
8.9 for a rescanning pattern and 10.3 for a class run, confirming the rate.

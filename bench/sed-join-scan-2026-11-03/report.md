# sed joins and windows that stopped at the work limits, 2026-11-03

Problem: `sed` idioms that join or window lines stopped part way over large
input.

- Joining a file with `:a;N;$!ba` charged the whole pattern space on each
  `N`, so its cost was quadratic: about 14 KB of 10-byte lines used up the
  expansion-work limit (10,000,000 units).
- A two-line window, `$!N;P;D`, charged twice the input as expansion work and
  a step per record, so it stopped at 100,000 lines (`maxSteps`).
- Over the 8,055 pages of the 10,000-page wiki, `sed -i
  ':a;N;$!ba;s/\n\n\n*/\n\n/g'` and `sed -n '$!N;/owner\n/P;D'` stopped part
  way.

## Change (`src/shell/commands/sed.ts`)

- `n` and `N` no longer charge the space they build; reading is bounded by
  the bytes read, as a cycle's read is.
- A branch back or `D` restart takes a step only when no record was read
  since the last one. A loop that reads as it goes is bounded by its input,
  as a forward pass is.
- What a pass does to the space is charged where it is done. A scan of the
  pattern space — a regular-expression address, an `s` pattern, or `P` and
  `D` finding the first line — is charged for what it covers beyond an
  allowance. Each record read lets each scan site cover it twice
  (`SCAN_PASSES`, alone and beside the next record in a window). The credit
  is per site and is added when that site next runs, so code that never runs
  adds nothing. Printing stays charged by the echo allowance (#139), and `G`,
  `H`, `x` and `y` stay charged by the spaces they copy.

So `:a;N;$!ba` costs what the file's size does. `:a;N;/end/!ba`, which scans
the growing space again on every pass, is charged for it. `:a;s/x/x/;ta`,
which scans with nothing read, costs what it did on main.

`test/sed-expansion-work.test.ts` pins both sides:
- joins, windows (with an address and an `s`) and `n` run on 18,890
  characters under 1,000–5,000 units and 100 steps;
- a non-reading `s` loop needs the same 85,000 units it needed on main;
- rescanning a growing space with `/never/`, `s`, `P` or `G;h`, or with 300
  unreachable `s` commands, stops at the limit.

## Results

Local workerd, main (ac10c80) beside this branch, over the 10,000-page wiki
(`local-workerd-outcomes.log`):

| Command | main | this branch |
| --- | --- | --- |
| `sed -i ':a;N;$!ba;s/\n\n\n*/\n\n/g' /wiki/*/*.md` | expansion work limit | completes, 0.50 s¹ |
| `sed -n '$!N;/owner\n/P;D' /wiki/*/*.md \| wc -l` | expansion work limit | completes, 0.32 s |
| `sed '$!N;P;D' /wiki/sales/*.md \| wc -l` | stops after 62,432 lines | 65,106 lines, 0.05 s |
| `sed -n ':a;N;$!ba;s/\n/ /g;p' /wiki/legal/topic-0*.md` | expansion work limit | 54,516 bytes |
| `sed -n ':a;N;P;$!ba' /wiki/legal/topic-0*.md` | expansion work limit | expansion work limit |

¹ Status 2: 40 of the lab's pages are read-only and are reported; all others
are rewritten.

On Node, joining one 900 KB file of 90,000 lines with `:a;N;$!ba;s/\n/ /g`
takes 52 ms, where main stops.

Timing, ten alternating pairs on commands main completes
(`local-workerd-pairs.jsonl`; the version before the reviews in the
`*-before-review*` files), same output in every pair:

| Command | ratio (95% bootstrap) |
| --- | ---: |
| `sed 's/owner/OWNER/' /wiki/*/*.md \| wc -l` | 1.018 (0.996–1.043) |
| `sed -n '/owner/p' /wiki/*/*.md \| wc -l` | 0.994 (0.978–1.011) |
| `cat /wiki/sales/*.md \| sed 's/x/y/' \| wc -l` | 1.002 (0.990–1.017) |
| `sed '/^$/d' /wiki/legal/*.md \| wc -l` | 0.990 (0.960–1.027) |
| `sed '$!N;P;D'` over 100 pages | 1.046 (1.000–1.118), 4 ms |
| `sed -n ':a;N;$!ba;s/\n/ /g;p'` over 100 pages | 0.944 (0.841–1.059), 4 ms |
| geometric mean | 0.999 |

Full local suite on the code as committed (`bench:local:paired`,
`local-group-v1`, full plan, four sessions with `ORDER_OFFSET` 0, 1, 0, 1;
`local-paired-s1..4.json`, `../summarize-local-pairs.mjs`): overall 0.999,
families 0.988–1.007. Nine workloads measured above 5%, most from one
session (1.61, 1.48, 1.31 in session 4), all running Git and no sed. Twelve
pairs in two sessions over their six groups (`local-paired-recheck-o0/1.json`):
overall 0.985, the nine at 0.971–1.037, and two other Git workloads rose
above 5% (`git/diff/100/cache` 1.092, `coding-mixed/status-clean/100` 1.055).

## Reviews

Two independent reviews, with instrumented copies of main and the branch
and a differential over 13,800 random scripts at default and tight limits.
Output was identical wherever both completed. They found three problems in
the first version, all fixed:

- A non-reading regex loop (`:a;s/  / /;ta`, commafying numbers) was charged
  twice, by the loop and by the scan, about 2× main. The loop now takes only
  the step, and those loops measure what they did on main.
- The allowance was one pool per script, sized by its commands: an addressed
  `s` got one allowance for two scans, and unreachable commands lent
  allowance to the rest (300 dead `s/q//` made `:a;N;/never/!ba` 100× cheaper;
  100,000 of them let it run 4.3 s). Credit is now per scan site, added only
  when the site runs.
- `P` and `D` search the space `N` built for its first line, which flattens
  it, and were not charged: `sed -n ':a;N;P;$!ba'` over 90,000 lines took
  3.4 s where main stopped in 10 ms. They are scan sites now and stop at the
  limit in 11 ms.

## Behaviour that differs

- Joins, windows and `n` run on input their size admits.
- A join loop that runs several regular expressions over the growing space on
  each pass (`:a;N;s/q/z/g;s/\n/ /;ta`) is charged for each scan. It stops
  sooner than on main, which charged the space once per `N`: at about 1,400
  5-byte lines instead of 1,800. That is the work it does.

## Bundle size

Two presets went over their budgets and were raised to their measured size
rounded up to 128 bytes: default-registry 648,064 (+1,664), linux-profile
859,648 (+1,664).

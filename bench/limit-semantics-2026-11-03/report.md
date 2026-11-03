# Limits that guarded nothing, and work no limit counted, 2026-11-03

A review of what each shell limit protects (the 0.6.0 limits proposal) found
three limits that stopped ordinary agent work while guarding neither memory
nor cost, and two kinds of work no limit counted. On Workers `Date.now()` is
frozen between I/O and inline SQLite reads never yield a macrotask, so
synchronous work is bounded by counts, not by the deadline.

## Changes

- **Regular expressions** (`src/core/posix-regex-matcher.ts`,
  `src/shell/commands/regex-meter.ts`): every step a `grep`, `sed` or `awk`
  search takes is charged as expansion work, 64 steps a unit, in batches of
  1,024 units. A literal pattern is found with `indexOf` and takes none.
  Before, a 120-branch `grep -cE` over a 4 MB file ran 38.5 s on Node with a
  frozen clock, past Cloudflare's 30 s CPU limit, and `grep -cwE 'x[^z]*z|x'`,
  which rescans a 40 KB line on every search, ran 36 s under the demo's
  limits. A first version charged only steps beyond 32 a position per search;
  a review showed rescans and many cheap patterns (`-e` × 100, a cached awk
  regex in a loop, 15–29 s) slipped under it, so all steps are charged.
- **Pipeline stages** (`src/shell/shell-evaluate.ts`): each stage after the
  first holds 96 KiB of `maxBufferedBytes` until the pipeline settles. 3,000
  stages of `cat` held 81–130 MB uncounted.
- **Streamed records** (`src/shell/commands/line-reader.ts`, `text-slice.ts`):
  lines a command reads and lets go are no longer counted against
  `maxBufferedRecords`; `sort`, `comm`, `join`, `xargs` and awk arrays, which
  hold them, still are. A 150,000-line file failed `grep -c`, `awk END`,
  `sed -n '$p'`, `uniq` and `head -n 120000` with "input record limit
  exceeded".
- **Pipe edges**: no cumulative cap. An edge holds at most 64 KiB, and what
  passes counts as total I/O; `maxPipelineBytes` bounds only what a
  redirection buffers before publishing a file.

## Results

Node, frozen clock (`regex-cpu.mjs`-style probes in the reviews):

| Script | before | after |
| --- | --- | --- |
| 120-branch `grep -cE` over 4 MB | 38.5 s | stops at the limit after 4.5 s (0.45 s at the demo's limits) |
| `grep -cwE 'x[^z]*z\|x'`, 40 KB line, demo limits | 36.2 s | stops after 0.45 s |
| 100 × `-e` two-branch patterns over 3.9 MB | 29.2 s | stops after 4.5 s |
| `grep -c` and `uniq` over a 150,000-line file | input record limit | 58,146; 150,000 |

Local workerd, main (2d7f95c) beside this branch, ten alternating pairs over
the 10,000-page wiki (`local-workerd-pairs.jsonl`; the first version in
`local-workerd-pairs-before-review.jsonl`):

| Command | ratio (95% bootstrap) |
| --- | ---: |
| `grep -cE '[a-z]+ [0-9]+' /wiki/sales/*.md \| tail -1` | 1.003 (0.993–1.013) |
| `grep -rn owner /wiki \| tail -1` | 0.992 (0.979–1.003) |
| `grep -E 'owner\|team\|budget' /wiki/legal/*.md \| wc -l` | 0.993 (0.979–1.007) |
| `sed -n '/own(er)?/p' /wiki/*/*.md \| wc -l` | 1.000 (0.990–1.011) |
| `sed -E 's/(owner\|team)/X/g' /wiki/sales/*.md \| wc -l` | 0.994 (0.973–1.008) |
| `awk '/owner\|team/' /wiki/legal/*.md \| wc -l` | 0.997 (0.988–1.006) |
| `cat /wiki/sales/*.md \| grep x \| sort \| uniq -c \| wc -l` | 1.028 (1.007–1.052), 24 ms |
| geometric mean | 1.001 |

Output was identical in every pair. In the first version's pairs,
`grep -E 'owner|team|budget' /wiki/*/*.md | wc -l` stopped at the 8 MiB edge
on main and printed 113,160 here.

Full local suite on the code as committed (`bench:local:paired`,
`local-group-v1`, full plan, four sessions with `ORDER_OFFSET` 0, 1, 0, 1;
`local-paired-s1..4.json`, `../summarize-local-pairs.mjs`): overall 1.007,
families 0.988–1.037. Sixteen workloads measured above 5%, twelve of them the
`git-shell` 1,000-file group (1.06–1.18, sessions 3 near 1.0), which runs only
`git` commands that import none of the changed modules. Twelve pairs in two
sessions over the flagged groups (`local-paired-recheck-o0/1.json`): overall
0.996, `git-shell` 0.998, two workloads above 5% (`coding-mixed/status-clean/100`
1.070, `git-shell/add-one/1000` 1.055); an A/A control of main against itself
over the `git-shell` 1,000-file group (`local-paired-aa-git-shell-o0/1.json`)
measured 1.004 with two workloads at 1.050.

## Reviews

Two independent reviews. One found the bypasses of the first version's free
allowance above and checked the rest: every `compilePosixRegex` caller
passes a meter (grep, sed addresses and `s`, awk program and dynamic regexes,
`FS`, `split`, `match`, `sub`, `gsub`); `case`, `[[ ]]` and globs use the
already-charged pattern matcher or the guarded glob regex; endless producers
still stop at 64 MiB of total I/O; 46 differential scripts matched main
wherever main completed; and the stage reservation is released after
failures, early closes, nested substitutions and `set -e` subshells (100
rounds each). Under the demo's 2 MiB buffered limit 22 stages run. The other
found a wide alternation of rare words refused at a few MiB under the first
version's eight steps a unit, which 64 a unit and the review's tests now
cover, and asked for the docs, CHANGELOG, test and naming fixes made here.

## Bundle size

Five presets went over their budgets and were raised to their measured size
rounded up to 128 bytes: awk 123,392 (+768), shell 258,944 (+256), interactive 268,800 (+384), default-registry 648,704 (+512), linux-profile 860,288 (+512).

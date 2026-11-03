# jq, sort and other whole-input commands read operands in bulk, 2026-11-03

Goal: make `jq` (and `sort`, `paste`, `diff`, `comm`, `join`, `tail`) over
many files as cheap per file as `cat` and `grep`, which take file operands
read ahead in bulk. These commands read every input whole before they start
(`inputTexts`), and opened a stream per file. Measured locally only: the SQL
lab on local workerd and the full local suite. No Cloudflare usage.

## Change

- `inputTexts` moved from `helpers.ts` to `src/shell/commands/inputs.ts` and
  takes each file operand from an `OperandReader`, as `inputSources` does:
  one `readMany` per window of 64 operands. A body it hands out is decoded by
  `readFileText`, which now takes those chunks in place of the file's stream,
  so a limit or invalid UTF-8 is reported with the file's path as before.
  What the read-ahead does not hold (`-`, a body over its allowance, a file
  changed since) is read as it was.
- `readFileText` keeps `fileSystem.readFile`, which refuses opaque R2
  bodies; these commands do not start streaming opaque content.

## Results

Local workerd, main (6e60c67) bundled beside this branch, both warmed, ten
alternating pairs over 2,000 small JSON documents seeded by
`../sql-lab/seed-json-2026-11-03.mjs` (`local-workerd-pairs.jsonl`, the code
as committed; the version before the reviews in
`local-workerd-pairs-before-review.jsonl`), outputs identical in every pair:

| Command | before | after | ratio (95% bootstrap) |
| --- | ---: | ---: | ---: |
| `jq -r .title files \| wc -l` | 70 ms | 32 ms | 0.451 (0.439–0.462) |
| `jq -c 'select(.size > 900) \| {id, owner}' files \| wc -l` | 72 ms | 34 ms | 0.459 (0.451–0.467) |
| `jq -s 'map(.size) \| add' files` | 70 ms | 30 ms | 0.424 (0.411–0.437) |
| `jq -r '.tags[]' files \| sort \| uniq -c \| sort -rn \| head -3` | 75 ms | 37 ms | 0.482 (0.459–0.514) |
| `sort files \| uniq -c \| sort -rn \| head -3` | 101 ms | 62 ms | 0.605 (0.589–0.620) |
| `cat files \| jq -r .id \| wc -l` (unchanged path) | 32 ms | 34 ms | 1.027 (0.991–1.061) |
| `diff a b`, 20 times | 3 ms | 2 ms | 0.691 (0.523–0.860) |
| `paste a b`, 20 times | 2 ms | 1 ms | 0.707 (0.574–0.871) |
| `tail -n 1 a b c`, 20 times | 113 ms | 112 ms | 0.986 (0.971–0.999) |

The control, `cat | jq`, reads the same files through the path that was
already bulk and is unchanged. The two-operand `diff` and `paste` loops are
near the resolution of the Worker's clock; they show no slowdown, not a
measured gain.

SQL cost (Node, counted by a reviewer): bulk reads take one statement per
window instead of one per file, and read an entry row and a chunk row per
file where `readFile` read one. `jq -r .title` over 40 files went from 42
statements and 81 rows read to 4 and 121; `sort a b` from 2 and 2 to 2 and
4; `tail -n1 a b c` from 3 and 3 to 2 and 6. When an operand fails, the
operands after it in its window may already have been read (`jq .
missing.json` before 40 files: 3 statements and 41 rows to 5 and 121), as
`cat` reads them.

Full local suite on the code as committed (`bench:local:paired`,
`local-group-v1`, full plan, four sessions with `ORDER_OFFSET` 0, 1, 0, 1;
`local-paired-s1..4.json`, `../summarize-local-pairs.mjs`): overall 0.995,
families 0.989–1.004; SQL statements 2,097,243 → 2,097,246 and rows read
2,096,849 → 2,096,832, the differences in Git workloads whose object writes
vary run to run. Five workloads measured above 5%: `diff-staged` in
`coding-mixed` and `coding-small` (1.107, 1.066), `git/commit/1000/cache`
(1.079), `git-shell/commit/1000` (1.073) and `coding-mixed/checkout-main/1000`
(1.060). Each runs only `git` (`git diff --cached`, `git commit`, `git
checkout`), which calls neither `readFileText` nor `inputTexts`.

Twelve pairs in two sessions over their five groups
(`local-paired-recheck-o0/1.json`): overall 1.000; four of the five fell
below 5%, three other workloads rose above it, and `git-shell/commit/1000`
stayed at 1.086. Twelve pairs in two sessions of that group alone, beside an
A/A control of main against itself (`local-paired-ab-git-shell-o0/1.json`,
`local-paired-aa-git-shell-o0/1.json`): `git-shell/commit/1000` 1.005
(sessions 0.967, 1.044) against A/A 1.006 (0.986, 1.026); the group 1.001
against A/A 1.006, none above 5% in either.

## Reviews

Two independent reviews compared main with this change over 377 cases each
way (missing files, directories, `ENOTDIR`, empty and broken operands, `-`
mixed and repeated, relative paths, invalid UTF-8, BOM, empty files, a stage
that rewrites, removes or `chmod`s a file while standard input is read) at
chunk sizes 4096 and 7, with a counter showing the bulk path taken: no
difference in output or status. Both found that a read-byte or buffered-byte
limit tripping at a bulk-read file lost the file's path in its message
(`/m/f09: shell file read byte limit exceeded` became the message alone);
bulk bodies now go through `readFileText`, and `test/input-texts-bulk.test.ts`
compares five low-limit cases with reading each file as a stream. They also
asked for a statement count proving the bulk path runs and for non-ASCII text
split across chunks; the test has both. Peak memory stays within the
read-ahead's existing bound (1 MiB per execution, a quarter of the remaining
buffer per fill).

## Behaviour that differs

None in output. A command reads a window of operands before it reaches a
failing one, as `cat` does.

## Bundle size

Two presets went over their budgets and were raised to their measured size
rounded up to 128 bytes: default-registry 646,400 (+128), linux-profile
857,984 (+256). Alone, `jq`, `sort`, `paste`, `diff` and `comm` each grow
about 2 KB minified, `ReadAhead` and `OperandReader`.

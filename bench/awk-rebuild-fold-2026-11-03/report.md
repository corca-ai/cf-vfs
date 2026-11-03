# awk record rebuilds and fold, 2026-11-03

Two follow-ups left after #142 and #144.

## awk: four builds a record

#142 gave each record read an allowance of its own length for building text,
so the first rebuild of a record was free and the second was charged in full.
Removing two columns, `awk '{ $3 = ""; $4 = ""; print }'`, rebuilds the record
twice and stopped at the work limit over the 8,055-page wiki. Each record now
grants four times its length (`BUILDS_PER_RECORD`): a few edits of a record are
free and what is built beyond them — a fifth rebuild, a loop rebuilding it,
a substitution growing it fivefold — is charged, so the free total stays within four times the
input read.

Local workerd, main (a3199c3) beside this branch, over the 10,000-page wiki
(`local-workerd-outcomes.log`):

| Command | main | this branch |
| --- | --- | --- |
| `awk '{ $3 = ""; $4 = ""; print }' /wiki/*/*.md > /dev/null` | work limit (expansion 8.5M) | completes, 0.86 s |
| `awk '{ $2 = "x"; $3 = ""; …; $6 = ""; print }' /wiki/*/*.md > /dev/null` | work limit (expansion 9.6M) | completes, 1.34 s |

Two reviews found that the allowance counts characters while each build has a
fixed cost of a few hundred nanoseconds, so on records of one or two
characters four times their length covered many rebuilds (eight `$1=$1` on
`a` records ran at 30 µs a unit), and that padding fields to assign `$50000`
with an empty `OFS` was free on main too (about 5,000 µs a unit). Each build
now also costs two characters, inside the allowance, and padding costs a unit
a field: eight `$1=$1` over 300,000 `a` records runs at about 0.6 µs a unit
and `$50000` over 200 records at 0.06.

## fold without an await per line

`fold` iterated `readTextLines` and awaited a write for every piece of every
line. It now visits lines with `eachLine(textLines(...))` and puts each piece
into the `BufferedTextWriter`, as `cut`, `uniq` and `nl` do (#144), awaiting
only when the buffer reaches its sink. The reviews also found the piece loop
quadratic on a long line, and main's too: `characters.splice(0, width)`
shifted the rest each time, so `fold -w 1` on a 128 Ki line took 3.6 s and on
a line at the 1 MiB cap minutes, with an array of every character held
outside the budget. Pieces are now cut by offset over the string: a 1 MiB
line takes 40 ms at `-w 1` and 5 ms at the default width. Output was byte-identical to main over the line-utility differential
(`test/line-utilities-bulk.test.ts`, now with four `fold` cases, one past the
writer's 64 KiB buffer).

## Timing

Ten alternating pairs (`local-workerd-pairs.jsonl`), same output in every pair:

| Command | ratio (95% bootstrap) |
| --- | ---: |
| `fold -w 80 /wiki/sales/*.md \| wc -l` | 0.774 (0.759–0.790) |
| `cat /wiki/sales/*.md \| fold -w 40 \| wc -l` | 0.790 (0.781–0.801) |
| `awk '{ $3 = ""; print }' /wiki/legal/*.md \| wc -l` | 0.998 (0.985–1.010) |
| `awk '{ $3 = ""; $4 = ""; print }' /wiki/legal/*.md \| wc -l` | 0.964 (0.953–0.975) |
| `awk '{ gsub(/owner/, "O"); print }' /wiki/legal/*.md \| wc -l` | 1.011 (0.997–1.027) |

Full local suite (`bench:local:paired`, `local-group-v1`, full plan, four
sessions with `ORDER_OFFSET` 0, 1, 0, 1; `local-paired-s1..4.json`,
`../summarize-local-pairs.mjs`): overall 0.997, families 0.989–1.006. Six
workloads measured above 5%, all Git or file operations that run no awk or
`fold`. Twelve pairs in two sessions over their five groups
(`local-paired-recheck-o0/1.json`): overall 1.000; none of the six stayed
above 5%, and three other Git workloads rose to 1.057–1.104.

## Reviews

Two independent reviews. They found `fold`'s quadratic piece loop and the
character array it held (both on main too), the per-build fixed cost that let
tiny records rebuild cheaply under a fourfold allowance, and free field
padding with an empty `OFS` (on main too); all are fixed as described above.
`fold` matched main in all 364 differential cases (multibyte text, lone
surrogates, BOM, CRLF, invalid UTF-8, the line cap, widths 1–80, early
closes, bulk, 1-byte file chunks and chunked stdin). They also asked for the
boundary tests — four builds free, a fifth or a threefold concatenation
charged, tiny records and padding charged — and the CHANGELOG wording here.

## Bundle size

Three presets went over their budgets and were raised to their measured size
rounded up to 128 bytes: awk 123,520 (+128), default-registry 654,208 (+256), linux-profile 865,792 (+256).

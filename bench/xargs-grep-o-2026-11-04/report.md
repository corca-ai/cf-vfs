# xargs and grep -o without an await per value, 2026-11-04

`xargs` read its input with `for await` over `readTextLines`, and `grep -o`
awaited a write for every match and went through the context-line path even
with no context lines. `xargs` now visits lines with
`eachLine(textLines(...))`, as `cut`, `uniq`, `nl` and `fold` do (#144, #151),
and `grep -o` without context puts each match into the `BufferedTextWriter`,
awaiting only when the buffer reaches its sink.

## Timing

Local workerd, main (412bf1d) beside this branch over the 10,000-page wiki,
ten alternating pairs (`local-workerd-pairs.jsonl`), output identical in every
pair:

| Command | ratio (95% bootstrap) |
| --- | ---: |
| `grep -oh "[a-z]*" /wiki/sales/*.md \| wc -l` | 0.929 (0.923–0.936) |
| `grep -ohE "\[\[[^]]+\]\]" /wiki/*/*.md \| wc -l` | 0.953 (0.943–0.965) |
| `grep -o owner /wiki/*/*.md \| wc -l` | 0.984 (0.977–0.991) |
| `cat /wiki/sales/*.md \| grep -o owner \| wc -l` | 1.017 (0.979–1.056) |
| `find /wiki -name "*.md" \| xargs -n 1000 echo \| wc -l` | 0.978 (0.954–1.008) |
| `find /wiki/sales -name "*.md" \| xargs wc -l \| tail -1` | 0.982 (0.958–1.007) |

`grep -o` gains with the number of matches; most of what remains is the
expression engine, about 1 µs a match. `xargs` is within noise: its input is
short next to what it runs. Its change stays for the linear `-0` below.

Plain `grep`, which shares the changed visitor, measured 1.042 (1.006–1.072)
on one 25 ms command. Twenty pairs measured `grep owner /wiki/*/*.md` 1.002
(0.994–1.011), `grep -n` 1.005 (0.997–1.013) and the 25 ms command 1.003
(0.976–1.032).

Full local suite (`bench:local:paired`, `local-group-v1`, full plan, four
sessions with `ORDER_OFFSET` 0, 1, 0, 1; `local-paired-s1..4.json`,
`../summarize-local-pairs.mjs`): overall 1.003, families 0.995–1.009. Five
workloads measured above 5%. Twelve pairs in two sessions over their five
groups (`local-paired-recheck-o0/1.json`): overall 1.003; none of the five
stayed above 5%, and four other Git workloads rose to 1.057–1.098. None of
these runs `grep -o` or `xargs`. SQL statements and rows differ only in the
Git workloads whose object order varies between runs, by under 0.01%.

## Reviews

Two independent reviews. One compared bundles of main and this branch over
11,570 scripts and 454 stdin cases, with no difference; a deliberately broken
write order gave 16, so the comparison could see one. The bypassed context
state is read only with context lines active.

The other found no change in yields, charging or accounting, and that the new
differential cases compared the code with itself, so seven mutants passed;
tests with absolute expected output were added. It also found three problems
already on main, all fixed here:

- `grep -o .` on a 1 MiB line held a span and a string for each match outside
  the budget, and ran out of a 256 MB heap. One pattern's matches now stream:
  1,000,000 matches in 281 ms under a 128 MB heap. Several patterns still
  gather their spans, to order them.
- `grep -oiF` lowercased the whole line for every match, quadratic in its
  length. It now does so once: 10,900 matches in 5 ms.
- `xargs -0` joined and split everything held so far for every line of a value
  spanning many lines, quadratic and outside the budget. Only the new line is
  split now, and a value past `maxBufferedBytes` is refused: 65,000 lines in
  6 ms.

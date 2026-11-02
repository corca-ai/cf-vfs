# Shell pipes without a native stream per chunk, 2026-11-02

Goal: make pipelines (`cat … | grep`, `wc -l … | tail`) cheaper on Workers,
where every enqueue into a native `ReadableStream`, every read from one and
every reader lock crosses into the runtime. Measured locally only: Node, and
the SQL lab on local workerd (`npm run lab:local`), whose direction matched
every Cloudflare result on record
([calibration](../local-workerd-2026-11-02/report.md)). No Cloudflare usage.

## Where the crossings were

Per chunk through `cmd1 | cmd2`, before:

1. `cmd1`'s write enqueued into the pipe's native stream.
2. The stage input (`shellInput`, a native stream with a high-water mark of
   zero) was pulled by `cmd2`'s reader; its pull took a reader on the pipe,
   read one chunk and released the reader — a lock, a read and a release.
3. The pull enqueued the chunk into the input stream, and `cmd2` read it.

## Change

- The pipe keeps chunks in a JavaScript queue (`src/shell/pipe.ts`).
- `getReader()` on a pipe, and on a stage input, returns a reader that reads
  the queue or the input cursor directly (`src/shell/direct-read.ts`). It
  takes the native lock once, so `locked` and a second `getReader()` behave
  as before, and it is an `instanceof ReadableStreamDefaultReader`.
- The stage input's cursor reads the pipe with a reader that takes no native
  lock; the pipe counts as held while it reads.
- The stage input answers its readers as the stream over the cursor did:
  in order, one cursor read at a time, a read that finishes after its reader
  let go kept for the next reader, and every read and cancel failing once the
  source failed (`InputReads` in `src/shell/input.ts`).
- Whatever reads the native stream itself — `pipeTo`, a `Response`, async
  iteration — pulls from the same queue one chunk per read, so backpressure
  stays counted in bytes; from then on every reader is native. Errors reach
  the native stream at once, as before.

So a chunk through `cmd1 | cmd2` makes no runtime crossing; each command
still takes one native lock for its whole input.

### Earlier versions, rejected

- The first version (`first-version/`) only replaced the pipe's queue. Two
  independent reviews found that a chunk could be lost when a native read was
  abandoned and a reader took over, that a native consumer saw an abort only
  when it next read, and that the stage input still locked and released the
  pipe per chunk — two crossings where it saved two. It measured 0.984 on the
  same pairs.
- The second version (`second-version/`) also read the stage input directly
  and, on a native read, moved the queue into the native stream. Two more
  reviews found that with a high-water mark of zero a native consumer then
  woke a waiting writer only once the queue was empty, so a slow `pipeTo` in
  Node hit the output idle timeout; that overlapping reads of a stage input,
  or a reader released with a read pending, failed with EIO; and that after
  stdin failed once a later command saw the end instead of the error. It
  measured 0.930 on the same pairs (one cold pair included) and 1.000 on the
  full local suite.

## Results

Pipe micro (`pipe-lines`, 10,000 writes of a 29-byte line, drained as
written), local workerd: 2.0 µs a write before
(`../local-workerd-2026-11-02/micro.log`), 0.2–0.3 µs now (five runs of
2–3 ms).

Local workerd, item 1's shell (13e91eb) bundled beside this one, both
warmed with two runs first, ten alternating pairs over the 10,000-page S3
wiki (`local-workerd-pairs.jsonl`), outputs identical in every pair:

| Command | before | after | ratio (95% bootstrap) |
| --- | ---: | ---: | ---: |
| `cat /wiki/sales/*.md \| grep -c owner` | 41 ms | 36 ms | 0.908 (0.887–0.937) |
| `awk '{ print $1 }' glob \| wc -l` | 743 ms | 742 ms | 1.000 (0.995–1.006) |
| `wc -l glob \| tail -1` | 304 ms | 261 ms | 0.859 (0.848–0.872) |
| `grep -rc owner /wiki \| tail -1` | 368 ms | 367 ms | 0.999 (0.993–1.005) |
| `cat \| cut \| sort \| uniq -c \| sort \| head` | 107 ms | 103 ms | 0.954 (0.939–0.967) |
| `grep -h owner glob \| head -5` | 320 ms | 320 ms | 0.998 (0.989–1.005) |
| `sed -n s///p \| grep -v \| wc -l` | 58 ms | 59 ms | 1.015 (1.002–1.030) |
| `cat \| tr a-z A-Z \| wc -c` | 99 ms | 94 ms | 0.944 (0.925–0.961) |
| geometric mean | | | 0.958 |

The gain follows how many chunks a pipeline moves. Counted at the sink in
Node over the same wiki (stdout included): `wc -l glob | tail -1` writes
8,056 chunks, `cat dir | …` about 1,030, `awk '{ print $1 }' glob | wc -l`
27, `grep … | head` and `sed … | grep | wc` 3, because commands already
coalesce output into about 64 KiB writes. `wc -l glob` saves 43 ms over
8,056 chunks, 5.3 µs a chunk; `sed | grep | wc`, three chunks, is 1 ms
slower, within 5%. In Node a pipe costs about 0.5 µs more to set up (a
`getReader` override per pipe and stage input), 1.0–1.3 µs against
1.6–2.1 µs for a pipe carrying one chunk. On Cloudflare streams cost two to
three times more relative to JavaScript than on local workerd (an effect of
0.43 locally was 0.20 there), so the saving there is expected to be larger;
it is not measured.

Full local suite (`bench:local:paired`, `local-group-v1`, full plan, item 1's
graph against this one, four sessions with `ORDER_OFFSET` 0, 1, 0, 1;
`local-paired-s1..4.json`, `../summarize-local-pairs.mjs`):

| | ratio |
| --- | ---: |
| overall (190 workloads) | 1.004 |
| coding-mixed / coding-small | 1.002 / 1.004 |
| files | 0.997 |
| git / git-recovery / git-shell | 1.007 / 1.010 / 1.007 |

Seven workloads were more than 5% slower. Four are in the `git` family at
100 files with the metadata cache (`branch` 1.103, `commit` 1.066, `diff`
1.059, `add-one` 1.059). That family calls isomorphic-git on the filesystem
directly and never runs the shell, so no changed code runs in it; `diff`
there takes 0.32 ms, and the 20 µs difference is the suite's noise for it,
which A/A controls with the second version put at 1.177 for the baseline
against itself (`second-version/local-paired-aa-baseline.json`). The other
three (`coding-mixed/commit-partial/100` 1.054, `git-shell/init/1000`
1.052, `coding-mixed/commit-rest/100` 1.051) come from one session each
(1.15, 1.17, 1.27) with the rest near 1.

SQL replay: 2,097,240 statements before and 2,097,241 after; rows read
2,096,827 and 2,096,844. The differences are a few statements or rows in Git
workloads, as in A/A controls (Git's concurrent object writes).

## Behaviour that differs

- On Workers, a pipe now wakes a waiting writer as soon as its queue drops
  below capacity, as Node always did; the old native stream on workerd woke
  it only once the queue was empty. Stages therefore interleave as in Node,
  and lines that different stages write to one stderr can come out in a
  different order (a review found this with two `while read` stages each
  writing stderr), as can the point at which a command limit stops a busy
  pipeline. A slow native consumer on Workers (`executeTo`) no longer meets
  the output idle timeout while it is reading.
- Empty chunks are dropped, as workerd's streams did; Node delivered them.
  No reader in `src/` treats an empty chunk as the end.
- A write waiting for room fails with the reason when another descriptor of
  the same pipe aborts it; before, it waited for the execution to end.
- Cancelling a pipe whose writer has closed, with data still unread, reports
  the cancellation on workerd as it did in Node.
- Cancelling a stage input while a read of it is under way now cancels the
  pipe behind it; before, the cancel failed because the pipe was locked to
  the read, and the writer upstream was not told.
- A pipe read through `getReader()` and released can still be given to a
  `Response`; before, the stream counted as disturbed.

## Bundle size

The shell bundle grows by about 7.8 KB (the direct reader, the pipe queue
and the stage input's ordered reads). The four presets over their budgets
were raised to their measured size rounded up to 128 bytes: shell 258,688,
interactive 268,416, default-registry 634,880, linux-profile 846,336.

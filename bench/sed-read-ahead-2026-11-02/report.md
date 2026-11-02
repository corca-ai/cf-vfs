# sed -i over many files — writes, reads and limits, 2026-11-02

Goal: make `sed -i` over many files cheaper, the "edit" half of searching and
editing a large text corpus. Measured locally only: Node, and the SQL lab on
local workerd (`npm run lab:local`), whose direction matched every Cloudflare
result on record ([calibration](../local-workerd-2026-11-02/report.md)). No
Cloudflare usage.

## Where the cost was

- A trusted guarded rewrite is already three statements on a Durable Object:
  the entry lookup, the entry update and the chunk update. There was nothing
  to fold on the write side.
- `sed -i` read each operand through `readFile` and a stream, which costs a
  chunk query and, on Workers, a stream per file.
- `sed -i` charged its rewritten text to expansion work twice (once when the
  runner emitted it, again when it was buffered for the write), so 870 pages
  of 5 KB stopped at the 10,000,000-unit limit.

## Rejected: deferring and batching the writes

The first design queued rewrites and published up to 64 at a time with the
atomic `writeFiles`, rewriting one by one when a batch failed
(`rejected-deferred-batching.diff.txt`). Two independent reviews, each
checking against main, showed it cannot keep the old outcomes:

- another pipeline stage or execution in the same Durable Object sees files
  unedited for longer, and its writes collide with sed's stale tokens;
- once the deadline passes, every queued rewrite is lost, where the old code
  had already published the earlier files;
- a batch weighs the quota once for the set, so growth that single writes
  refuse can pass;
- hard links and a link named before its target read stale bodies.

The write-side saving (6.0 to 4.06 statements per file locally, same time)
did not justify that.

## Adopted

- `sed -i` reads operands through the read-ahead and publishes each rewrite
  at once, as before.
- The read-ahead keeps held bodies across changes: after any change it hands
  a body over only once a fresh stat of its path shows the same entry,
  revision and mutation token, and it skips files with other hard links. A
  review instrumented this to re-read every handed-out body: over 7,812 runs
  and 241,187 hand-outs with 14 kinds of concurrent change, no stale body and
  no body `readFile` would have refused.
- `sed -i` charges the rewritten text once.
- The read-ahead holds bodies in a 1 MiB pool per execution instead of the
  shell's buffer, so buffer limits trip where reading one file at a time
  trips them (with read-ahead, `cat`/`grep` over many files could hit
  `maxBufferedBytes` earlier).
- A revalidation that the shell's policy refuses falls back to the ordinary
  read, which reports the refusal per file.

## Results

Node (`profile-eval`, same 10,000-page S3 wiki, evaluation user, 278 files
under `wiki/legal/guide-*` and `wiki/ops/guide-*`): SQL statements 1,952 on
main, 1,679 on the candidate (−14%), the same 31–32 ms. 870 files
(`wiki/sales/*.md`): main stops at the expansion-work limit; the candidate
completes in 90 ms and 6,166 statements.

Local workerd, main's shell bundled beside the candidate's, six alternating
pairs (`local-workerd-pairs.jsonl`):

| Command | main | candidate | ratio (95% bootstrap) |
| --- | ---: | ---: | ---: |
| `sed -i` over 278 files | 47 ms | 37 ms | 0.851 (0.806–0.899) |
| `sed -i` over 870 files | 122 ms (fails at the limit) | 107 ms | — |

Cloudflare amplifies stream and allocation savings over local workerd (an
effect of 0.43 locally was 0.20 there), so the reduction there is expected to
be larger; it is not measured.

## Behaviour that differs from main

- `sed -i` over many files no longer stops at the expansion-work limit.
- Buffer limits for commands that read ahead trip where reading one file at a
  time trips them, which can be later than main.
- A stage running concurrently with a reading command may interleave
  differently, because bulk reads await less often than streams; each outcome
  is one a reader could see. This was already so for `cat` and `grep` since
  read-ahead shipped.

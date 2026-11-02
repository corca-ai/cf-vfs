# Fixed-shape statements and bodies as TEXT, 2026-11-02

Two ideas for cheaper bulk reads (`readMany`, `statMany`), measured on the
SQL lab running on local workerd (`npm run lab:local`) over the 10,000-page S3
wiki, with Cloudflare results already on record. No Cloudflare usage. Neither
is adopted.

## Fixed-shape statements

The idea: `statMany` and `readMany` build `VALUES (?),(?),…` with one
placeholder per path, so a batch of 1 to 64 paths is one of 64 statement
texts for each statement. Padding every batch to 64
placeholders with NULLs would leave one text each, so the runtime would
prepare each statement once.

`statement-shapes.log` (`../sql-lab/statement-shapes-2026-11-02.mjs`): one
request of 64 entry lookups over 64 paths, nine alternating rounds, medians:

| Statement texts | rows returned | ms per 64 statements |
| --- | ---: | ---: |
| the same text every time | 4,096 | 6.87 |
| a new text every time (prepared each time) | 4,096 | 8.45 |
| 32 to 64 placeholders, as batches vary | 3,041 | 6.23 |
| always 64 placeholders, the rest NULL | 3,041 | 6.15 |

A prepare costs about 25 µs a statement here — a review split it from the
request overhead (about 1.4 ms a request) and the row work (about 48 µs a
statement) at 21–30 µs — but the varying and padded shapes cost the same:
the runtime keeps prepared statements by their text. `statement-cache.log`
(`../sql-lab/statement-cache-2026-11-02.mjs`): 1,024 statements per round
cycling through 32 to 1,024 texts unique to the run. Only the first round
pays for preparing; from the second round on a statement costs the same
(99–109 µs, request included) at 32 texts or 1,024.

The cache is bounded by the bytes of SQL text, not the number of
statements: the review padded each text with a comment and found misses
from about 1 MiB of distinct text, least recently used first (8,000-byte
texts hit at 96 shapes, about 799 KiB, and missed at 128, about 1,065 KiB).
The bulk reads produce at most 192 texts — 64 each for `statMany`'s lookup,
`readMany`'s lookup (indented differently, so a different text) and its
bodies statement — about 118 KiB in all. They stay cached unless other
distinct SQL in the same object passes about 0.9 MiB. Each is prepared once
per Durable Object instance: about 5 ms for all of them locally, and at the
calibrated five to nine times 25–45 ms on Cloudflare once per cold start.
Padding would save that once and bind up to 63 NULLs on every call. Not
worth a change.

## Bodies as TEXT

The idea: `readMany`'s bodies statement returns each chunk as a BLOB, which
the runtime copies into a new `ArrayBuffer`, and commands then decode it.
Cast to TEXT, the runtime would hand over a string, and a command that wants
text would skip the decode.

On record, per 64-body batch of 5 KB pages, medians of five requests in
one session:

| Statement | Cloudflare | local workerd |
| --- | ---: | ---: |
| `entry_id, chunk_index, body` (BLOB, as `readMany` reads) | 6.24 ms | 0.68 ms |
| `body` alone (BLOB) | 5.16 ms | 0.68 ms |
| `CAST(body AS TEXT)` alone | 4.38 ms | 0.66 ms |
| `length(body)` only | 4.32 ms | 0.60 ms |

(`../sql-lab/entry-columns-2026-10-30-wiki10k.log`,
`../local-workerd-2026-11-02/entry-columns.log`). Reading the pages is the
floor (lengths only). Against the matching one-column BLOB statement, TEXT
saves about 12 µs a body on Cloudflare — 0.12 s over 10,000 pages — and the
samples overlap (BLOB 226–333 ms, TEXT 222–401 ms), so even that is
unresolved; the shape production would need, with `entry_id` and
`chunk_index`, was never measured. Locally TEXT saves nothing on this
all-ASCII wiki (0 of 10,000 pages contain a non-ASCII byte), and a review
measured non-ASCII 5.7 KB pages at 0.49 ms per batch as TEXT against
0.17 ms as BLOB: for non-ASCII text the runtime decodes to UTF-16 itself, so
TEXT moves the decode rather than removing it. Local workerd therefore
cannot show a gain, and adoption would rest on a Cloudflare check.

Exactness can be had. `text-cast.log` (`../sql-lab/text-cast-2026-11-02.mjs`)
and the reviews' probes cast bytes that are not valid UTF-8, and long and
mixed bodies:

- every invalid sequence becomes U+FFFD, as `TextDecoder` with `fatal` would
  reject it, so a chunk whose string has no U+FFFD was valid UTF-8 and maps
  back to its bytes exactly; NUL, CR, U+FFFF, emoji and a BOM inside a body
  survive, and bodies around 1 MB come back intact;
- the UTF-8 length does not tell invalid input apart (`F0 9F 98 61`, a
  truncated four-byte sequence, comes back as `U+FFFD a`, four bytes like
  the source), and the original bytes cannot be recovered from the string;
- a leading BOM survives the cast, where the shell's decoders drop it.

The consumers charge reads, check cancellation and enforce the line limit
per stored chunk (`chunkTextLines`, `collectChunkText`, `skipTextLines`).
Chunks are 256 KiB and `readMany` reads at most 1 MiB a call, so a wiki page
is one chunk (all 10,000 here). Two exact designs remain untested on
Cloudflare:

- **Per-chunk TEXT behind a guard**, in a text-only `readMany` mode:
  `CASE WHEN instr(c.body, x'EFBFBD') = 0 THEN CAST(c.body AS TEXT) ELSE
  c.body END` plus `length(c.body)`, using the string when it holds no
  U+FFFD (then it is valid UTF-8), stripping a leading BOM from the first
  chunk, and falling back to bytes for a character split at a chunk edge.
  Byte consumers (`cat`, `md5sum`, streams) still need bytes, so the mode is
  opt-in for text commands — `grep`'s no-match path and awiki's page reads
  decode a whole body and would be exact with a whole-body string — and
  touches `readMany`'s interface and every filesystem wrapper.
- **One BLOB per batch**: `group_concat` of the chunk bodies cast to BLOB,
  with a JSON array of each chunk's id, index and length, and the bodies as
  views into that one buffer. A review found it exact locally (NUL, invalid
  UTF-8 and BOM unchanged, 342,382 bytes for 64 pages) at 0.79 against
  0.71 ms per batch. It replaces 64 buffer allocations with one and raises
  no UTF-8 question; whether Cloudflare's BLOB cost is per allocation or per
  byte is what a small Cloudflare check would answer. A kept body holds the
  whole batch's buffer, up to 1 MiB.

Not adopted in this round: the gain is at most about 12 µs a body on
Cloudflare and unresolved, local workerd cannot show it, non-ASCII text may
cost more as TEXT, and either design needs a Cloudflare check — the one-BLOB
design first, since it is exact for any bytes.

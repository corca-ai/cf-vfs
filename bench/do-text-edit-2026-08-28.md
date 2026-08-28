# Durable Object small-text edit benchmark — 2026-08-28

Environment: Apple M4, macOS 26.5.1, arm64, Node v24.18.0, workerd through
`@cloudflare/vitest-pool-workers` 0.18.6. The before revision is `6e9a1b3`.
Inputs are 8 KiB strings representing a code or Markdown file. Counted SQL
work is the regression signal; elapsed time is supporting evidence because
local workerd timing is noisy.

| Operation | before statements / rows read / rows written | after | change |
| --- | ---: | ---: | ---: |
| guarded same-size edit | 7 / 13 / 4 | 4 / 9 / 3 | −43% / −31% / −25% |
| one-byte growth | 7 / 13 / 4 | 6 / 11 / 4 | −14% / −15% / — |
| same-size stream edit | 7 / 13 / 4 | 5 / 11 / 3 | −29% / −15% / −25% |
| changed `skipIfUnchanged` edit | 8 / 14 / 4 | 6 / 12 / 3 | −25% / −14% / −25% |
| unchanged warm `skipIfUnchanged` | 3 / 5 / 0 | 3 / 5 / 0 | — |
| credential-bound same-size edit | 9 / 25 / 4 | 5 / 15 / 3 | −44% / −40% / −25% |

Across five fresh workerd runs of 5,000 guarded same-size edits, median elapsed
time moved from 0.0502 ms to 0.0348 ms per write (−31%). A prototype that only
removed the oversized temporary slab did not show a stable timing improvement;
the statement and row reductions, plus removal of the 256 KiB transient slab
for strings, are the reasons the combined change was retained.

The string path publishes during the call and therefore cannot race with
another operation between planning and commit. Byte views, buffers, streams,
batches, and `skipIfUnchanged` retain the collect-then-revalidate path because
accessors can run caller code. Regression coverage pins accessor-triggered
mutation, stream concurrency refusal, mutation-token guards, POSIX permissions,
dynamic quotas, database headroom, in-flight accounting, usage events, and
all-or-nothing batches.

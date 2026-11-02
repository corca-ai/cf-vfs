# One BLOB per batch of bodies — small Cloudflare check, 2026-11-03

Follows [the TEXT and fixed-shape report](../sql-shapes-text-2026-11-02/report.md),
which left reading a batch of bodies as one BLOB as an exact candidate whose
Cloudflare cost was unknown. The user asked for the small check.

`../sql-lab/one-blob-2026-11-03.mjs`: 200 pages of the S3 wiki (962,647
bytes) seeded into a fresh lab object, their ids split as `readMany` splits
them (64, 64, 64, 8), and one request per arm running every batch ten times:

- `rows` — `entry_id, chunk_index, body` per chunk, as `readMany` reads now;
- `one-blob` — `group_concat` of the bodies cast to BLOB, with a JSON array of
  each chunk's id, index and length (it carried all 962,647 bytes);
- `lengths` — `length(body)` per chunk, the page-read floor;
- `empty` — `SELECT 1` as many times, the request's own cost.

Five pairs, the arms in a rotating order, timed at the client. On Cloudflare
the lab Worker was deployed with `cf` (version 1a649d6f), the run took 10 s
and the object was destroyed afterwards. One run, not repeated.

## Local workerd (`local-workerd.jsonl`)

| Arm | median request | per pair |
| --- | ---: | --- |
| rows | 8.2 ms | 9, 9, 7, 7, 8 |
| one-blob | 10.5 ms | 11, 11, 11, 10, 10 |
| lengths | 6.7 ms | 7, 7, 7, 6, 7 |
| empty | 2.8 ms | 3, 8, 2, 3, 2 |

`one-blob` / `rows` per pair: 1.237, 1.162, 1.408, 1.376, 1.251 (median
1.251). Joining the bodies costs SQLite a copy that per-row BLOBs do not.

## Cloudflare (`cloudflare.jsonl`)

| Arm | median request | per pair |
| --- | ---: | --- |
| rows | 294.8 ms | 333, 595, 295, 289, 283 |
| one-blob | 333.8 ms | 264, 334, 287, 434, 351 |
| lengths | 273.7 ms | 328, 274, 234, 262, 304 |
| empty | 255.5 ms | 256, 385, 211, 272, 204 |

`one-blob` / `rows` per pair: 0.794, 0.561, 0.974, 1.502, 1.240 (median
0.974); `lengths` / `rows`: 0.987, 0.460, 0.794, 0.907, 1.077.

**Unresolved.** The request itself — the client's round trip to Cloudflare —
cost 204–385 ms, while the SQL work in a request is about 40 statements at
the 2–6 ms per batch on record, so the spread of the empty requests is larger
than the difference being measured. Even the floor (`lengths`) does not
separate from `rows`. Nothing here contradicts the local result, and nothing
supports adopting the design.

A check that could answer it would make the SQL dominate the request: about
100 repetitions per request (some 400 statements, roughly a second of SQL)
with the same 200 pages and five pairs, still well inside the small-check
budget. That is a new run, to be made only if asked.

## Conclusion

Not adopted: locally one BLOB per batch is 1.25 times the current read, and
on Cloudflare this check could not tell them apart.

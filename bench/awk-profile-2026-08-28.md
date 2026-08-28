# AWK profile benchmark — 2026-08-28

This records the local evidence used to accept the opt-in AWK expansion. It is
not a cross-runtime comparison: language compatibility is covered separately by
the pinned BusyBox fixtures.

## Environment and method

- Apple M4, 32 GiB, Darwin 25.5.0 arm64
- Node.js 24.18.0, in-memory `NodeSqlFileSystem`
- one `Shell` instance, 10,000 newline-delimited records per execution
- 10 warmups followed by 41 timed samples; the table reports p10, median, p90
- feature runs raised only `maxSteps` and `maxLoopIterations` to 1,000,000 so
  measurement did not stop at the ordinary safety ceiling

## Results

| Scenario | p10 | Median | p90 | Median throughput |
| --- | ---: | ---: | ---: | ---: |
| associative aggregation over 100 keys | 18.847 ms | 20.227 ms | 27.665 ms | 494,384 records/s |
| one matching `gsub` per record | 32.887 ms | 36.396 ms | 50.069 ms | 274,752 records/s |
| inclusive range patterns | 16.287 ms | 16.895 ms | 18.776 ms | 591,904 records/s |
| three-iteration `for` per record | 24.869 ms | 25.715 ms | 31.722 ms | 388,884 records/s |
| inline scalar-count program | 7.291 ms | 8.052 ms | 13.369 ms | 1,241,895 records/s |
| the same scalar-count program through VFS `-f` | 7.387 ms | 8.195 ms | 9.181 ms | 1,220,331 records/s |

The median cost of loading the tiny program through `-f` was 0.143 ms, or 1.8%
of this whole 10,000-record execution. The final emitted AWK-only Worker was
89,407 bytes, up from 67,505 bytes for the scalar first profile. All eight
non-AWK tree-shaking presets remained byte-for-byte unchanged.

The measurements justify keeping these features in the same opt-in applet:
they add no cost to consumers that do not import AWK, and the common extended
operations remain in the hundreds of thousands of records per second locally.

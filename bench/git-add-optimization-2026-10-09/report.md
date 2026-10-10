# Whole-worktree Git add optimization — 2026-10-09

Status: complete; final implementation deployed and repeated on Cloudflare. No public filesystem API is added.
The target is the optional shell Git applet, preserving declared Git/POSIX
behavior, scoped credentials, budgets, tree shaking and existing bundle limits.

## Measurement

Baseline: source snapshot `/tmp/cf-vfs-add-baseline-20261009`, compiled using
`npm run build`. Local runs use Node 24.18.0, SQLite VFS, 1,000 small files,
three alternating warmup pairs and ten measured pairs. Each trial builds a
fresh repository, stages/commits, repeats unchanged staging, changes/stages one
file, stages its removal and removes/stages remaining files. Correctness is
verified outside timing. [Baseline phase profile](local-phase-baseline.json)
uses a temporary compiled-module probe, not shipped library instrumentation.
It measured inspection about 56 ms and staging about 110 ms, with 32 index
writes totalling 1,215,808 bytes.

The [candidate phase profile](local-phase-candidate.json) measured inspection
about 16 ms and staging about 103 ms, with eight index writes totalling
330,304 bytes. New blobs with absent HEAD/index entries need no comparison
hash: the engine reads/hashes them once during staging. Status and tracked-file
comparison still inspect actual bytes, detecting same-sized same-second edits.
Autocrlf, empty bodies and symlink blobs retain engine behavior.

Staging starts with 32 paths. Small-body batches can extend to 128 paths while
inspected total body size remains at most 1 MiB. Large bodies keep the previous
32-path bound; removal-only batches remain 256. Host serialization of repository
edits is still required. No cross-command content/stat cache is introduced.
The adaptive byte rule bounds only the larger batches, not all engine/native
buffer allocation. It does not make arbitrary repositories memory-safe.

[Local alternating comparison](local-adaptive-final-paired.json): full add
153.63→108.76 ms, ratio interval 0.6815–0.7232, SQL 21,708→19,228. Unchanged
add 51.92→53.18 ms (small local overhead); changed one-file/removal timing
intervals overlap equality. These are local timings, not CF CPU estimates.

## Actual Cloudflare

The suite keeps the same 120 rows, 27,056 assertions, body fixtures, inline
storage and local VFS Git remotes. Each run uses one warmup and three samples.
Wall time includes Worker→DO RPC dispatch and operation assertions, excludes
full body validation and teardown. No R2 or external Git transport is measured.
The common clock description explicitly separates direct-engine 32-file
batches from implementation-bounded shell staging. The earlier description
[baseline](cf-baseline-original-description.json) is archived separately;
it is not silently normalized to bypass strict comparison validation.

[Common-description baseline](cf-baseline.json): 1,000-file add 3,659 ms;
[128 candidate](cf-adaptive-128.json): 2,212 ms;
[128 repeat](cf-adaptive-128-repeat.json): 2,232 ms. All pass 27,056 assertions.
Unchanged add baseline 215 ms, candidate 193/180 ms; one-file add baseline
64 ms, candidate 77/51 ms, with noisy samples. The full-add improvement repeats.

## Other probes

- [256-file local probe](local-128-vs-256-paired.json) regressed 106.01→127.54 ms
  despite four fewer index writes and 80 fewer SQL statements. Its CF trial
  measured 2,376 ms versus 128-path 2,212/2,232 ms. It is rejected: no CF
  gain was established, and local latency regressed significantly.
- [Deferred-index probe](local-index-probe-paired.json) saved seven physical
  index writes but only 63 of 19,228 SQL statements and showed no local gain
  (105.88→106.81 ms). It still serialized the index each batch, introduced
  delayed-publication complexity and is not retained or deployed.
- [Flat matrix probe](local-flat-paired.json) had no meaningful gain and failed
  the complexity guard. Restored the structured implementation before deploy.

## Verification

Full checks pass for the combined final candidate: 1,884 Node tests, 143 workerd
tests, POSIX comparison 46/46, types/lint/knip/quality/docs, isolated package
consumers and all 12 bundle presets. New tests validate one read for new
regular/empty bodies with autocrlf and symlink blobs; mixed small/large staging
is checked byte-for-byte on workerd with default shell budgets. VFS core,
default shell and default registry bundle sizes are unchanged; optional Git
remains within its existing 563,968-byte budget (final candidate 543,327 bytes,
up 2,638 from the prior deployed build).
Further CF candidates and final deployment results follow below.

## In-flight configuration reads

The engine's concurrent workdir inspection starts many `_getGitConfig` calls
before its configuration value is populated. Sharing only overlapping UTF-8
reads of this command's exact repository config removes duplicate SQL/stream
work without retaining a completed value. The optional Git adapter owns this
behavior; no VFS interface, package export or core implementation is added.
Each logical reader still consumes its I/O allowance and operation checks.
The pending promise is cleared on success/error; the adapter itself is new for
each Git invocation. Worktree bodies and unrelated paths are not cached.

[Local alternating pairs](local-config-paired.json): unchanged add
54.47→40.27 ms, ratio interval 0.7210–0.7654, SQL 3,023→2,024. Initial add and
single-file/removal intervals overlap equality relative to the 128 candidate.
Tests verify bounded config read count, unchanged index, changed autocrlf
configuration on the next command, logical I/O-limit refusal through telemetry,
and successful command execution after a prior limit failure.

Pre-pool exact-byte deployment: eeb77ae0-ea9d-47f8-8b4a-6c1f08f4ff77; implementation
d6e4e2e75360b08f30efac9fbd76fd5360fd46285d742fc2a8992ffbe43f5103.

A UTF-8 boundary check revealed that re-encoding decoded replacement characters
would overcharge malformed input. Shared reads now carry the original byte
length; 200 readers of a three-byte configuration pass a 600-byte budget and
fail a 599-byte budget. Ordinary worktree reads retain their existing direct
path; only concurrent config reads use the shared result.

[Final local pairs](local-final-paired.json) include all three Git module
fingerprints: whole add 157.69→109.84 ms (ratio interval 0.6773–0.7166), unchanged
add 54.05→40.64 ms (0.7185–0.7702), one-file/removal intervals overlap equality.
An earlier combined CF run [before the exact-byte refinement](cf-final-candidate.json)
measured initial add 2,916 ms and unchanged add 174 ms. The
[final-build first run](cf-final-exact.json) measured initial add 2,366 ms but
unchanged add 761 ms (1,621 / 761 / 591), showing unresolved CF timing variance.
The later bounded-inspection result below supersedes this stage; its slow
samples are preserved rather than omitted.

## Bounded worktree inspection

A per-walk queue limits body collection and native blob hashing to 32 tasks,
leaving metadata traversal concurrent. Slots are handed directly to waiting
callers and released in `finally`, including failed reads/hashes. It avoids
retaining a module-global queue or sharing state across repositories. New-blob
staging still skips comparison reads; absent entries consume no slot.
This also lets the engine populate its per-walk configuration value before
starting most remaining body reads, reducing duplicate parsing in addition to
the adapter's shared physical read.

[Temporary pool prototype](local-hash-pool-paired.json) showed unchanged add
38.75→33.35 ms. The [final per-walk implementation](local-pool-final-paired.json)
confirmed 40.25→35.56 ms, ratio interval 0.8333–0.9172, with unchanged SQL counts.
Full add and one-file intervals overlap equality relative to the prior candidate.
Workerd's mixed-body case now repeats unchanged staging and checks the index
mutation token remains intact. Full checks pass: 1,884 Node +143 workerd,
POSIX 46/46, all existing checks and budgets. Git bundle 543,327 bytes; default
shell/registry/core unchanged. Final pool CF repetition is complete.

### Production pool result

[First pool run](cf-pool-candidate.json): initial add 2,180 ms (2,118 / 2,364 /
2,180), unchanged add 52 ms (41 / 61 / 52), one-file add 76 ms, deletion staging
69 ms. Compared with the common-description original baseline (3,659 / 215 ms),
whole-worktree staging improves materially. The queue addresses a source of
concurrent inspection work; it is not proof that all CF outliers are eliminated.
Each full run passes 27,056 assertions.

Actual final deployment: eade4f40-aff2-4a5d-aa0a-0235edea1890; implementation
51777acc528426ccd0d2bc0598e348ef9d28c370b247e7be80e10e12c7f5b015.
The same-build repeat is complete. Final retained implementation consists of the
new-blob comparison shortcut, adaptive 128-path staging, in-flight config
read sharing with exact logical byte accounting, and per-walk bounded body/hash
inspection. The 256-file, deferred-index and flat-matrix probes are absent.

## Final repeated result and limits

[Final repeat](cf-pool-repeat.json): initial add 2,168 ms (2,068 / 2,760 / 2,168),
unchanged add 87 ms (87 / 713 / 62). Relative to the original 3,659 /215 ms
baseline, both final runs show roughly 40–41% lower initial-add medians and
59–76% lower unchanged-add medians. One-file add measured 76/80 ms versus
64 ms in the baseline; deletion staging 69/112 ms versus 88 ms. These latter
operations show no established CF gain. A 713 ms unchanged-add sample remains;
tail latency has not been eliminated. All ten CF runs in this evaluation
passed 27,056 assertions across 120 rows.

[Complete local before/after pairs](local-complete-paired.json), with all three
Git module fingerprints, measured initial add 153.53→110.09 ms and unchanged
add 52.53→34.22 ms. One-file add overlaps equality; one-file removal has a
small local cost increase (5.56→5.83 ms). Avoid claiming every operation is
faster. The change targets full-worktree inspection/staging and native working
set pressure, rather than tiny path-specific operations.

Changed tracked files still require content comparison, and the existing
engine reads/hashes changed contents again when staging. Eliminating that
remaining duplication without weakening change detection or introducing unsafe
retained body snapshots requires further engine-level work. New-file staging
already avoids it. Deferred index publication was rejected because it did not
avoid serialization and had no measured gain. Compression and 1,000 individual
object writes remain substantial costs. No broad engine fork, new filesystem
API or relaxed permissions/budgets were introduced.

The final browser shell staged 64 files, committed, repeated unchanged add,
noticed a same-sized edit, staged/committed it and cleaned its unique directory:
[pool smoke](public-pool-smoke.txt). The previous canonicalization/symlink smoke
is archived in [terminal capture](public-shell-smoke.txt). The public benchmark
shows this deployment's saved result and a new public request reuses exactly
the same run and file mtime: [freshness evidence](public-final-reuse.json).
An independent [source fingerprint](source-fingerprint.json) matches the
Worker/DO benchmark build. Documentation/whitespace checks pass. Current source
contains none of the rejected 256-path, deferred-index or global-queue probes.

[Full check output](check.log) and [verification](verification.json) archive the
final gates and deployment. [Production summary](production-summary.json)
indexes every raw run. Default shell, default registry, VFS core and public
filesystem exports/signatures are unchanged by this work. Optional Git grows
2,638 bytes to 543,327, within its unchanged 563,968-byte budget.

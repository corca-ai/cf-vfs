# Git shell optimization candidates — 2026-10-09

Status: **production iteration in progress**. Initial sandbox restrictions were
resolved when unrestricted filesystem/network access was enabled. Git staging
has been deployed and evaluated twice on Cloudflare. The two-hour goal remains
active until 2026-10-08 23:44:42 UTC. No public filesystem API was added.

## Evidence and changes

The optional Git applet scanned and hashed the whole working tree for a
one-file add. It also recompressed unchanged files and rewrote the Git index
once per deleted path. The candidate prunes unrelated walker children before
their stat/body access, skips content/mode matches, shares the index cache only
within the add command, and groups deleted paths in batches of 32. New-path
ignore checks already performed by the matrix are not repeated by the engine;
HEAD-only paths retain its normal ignore check. No public filesystem API is
added, and compression remains bounded to 32 paths.

The first unpaired measurements are saved alongside this report. A subsequent
comparison runs both implementations in one Node process, alternating order,
with three warmup pairs and ten measured pairs. Each trial builds a fresh
1,000-file SQLite VFS, stages/commits it, repeats unchanged staging, modifies
one file, stages its removal, then deletes and stages all remaining files.
Bodies contain approximately 0.6–0.7 KiB text. Validation is outside timers.
Both versions use enlarged I/O/mutation budgets so the old repeated-index
removal implementation can finish; the new public shell workflow separately
passes default shell budgets. Node v24.18.0, installed isomorphic-git 1.43.1.

| Operation | Baseline median ms | Candidate median ms | Paired ratio (95% interval) | SQL calls |
| --- | ---: | ---: | --- | --- |
| Initial add-all | 246.92 | 229.98 | 0.938 (0.920–0.947) | 35,762 → 33,728 |
| Unchanged add-all | 135.28 | 52.89 | 0.391 (0.382–0.401) | 6,666 → 3,023 |
| Add one file | 54.63 | 6.34 | 0.116 (0.114–0.122) | 3,062 → 62 |
| Stage one removal | 54.14 | 6.55 | 0.121 (0.110–0.130) | 3,044 → 44 |
| Stage all remaining removals | 542.06 | 17.86 | 0.033 (0.032–0.034) | 20,026 → 633 |

[Raw pairs and compiled Git-module fingerprints](git-shell-paired.json) are
authoritative. These intervals describe this local experiment, not CF RPC
latency or native Git speed. Baseline functions were reconstructed from the
previous deployed applet; [the reconstruction](reconstruct-baseline.mjs) is
explicit and only replaces gitMatrix/gitAdd in a temporary source copy. Other
library code, runtime and dependencies are equal.

```sh
node bench/cf-improvement-2026-10-09/reconstruct-baseline.mjs /tmp/cf-vfs-two-hour-baseline
node node_modules/typescript/lib/tsc.js -p /tmp/cf-vfs-two-hour-baseline/tsconfig.build.json
npm run build
node bench/cf-improvement-2026-10-09/git-shell-paired.mjs \
  /tmp/cf-vfs-two-hour-baseline/dist dist /tmp/git-shell-paired.json
```

The temporary baseline must first contain a copy of src and both tsconfig
files, a package.json with type=module and access to the installed node_modules.

## Production measurement preparation

Existing public `git` rows call isomorphic-git through the FS adapter; they do
not measure the shell applet. A separate `git-shell` group now executes Git
commands through Shell on 100/1,000-file repositories, measuring initial,
unchanged, one-file and removal staging, plus local bare/worktree clone,
fetch, push and fast-forward pull. Changed staged bytes, final empty
index and original committed history are validated outside RPC timing. The
group has no adapter metadata-cache variant. Existing workloads are unchanged;
the complete result grows from 88 to 118 rows. The UI labels the two Git groups
separately and still displays older saved results.

The ten-minute VFS result-mtime policy, read-only GET, authenticated refresh,
alarms, checkpoints and build verification are preserved. Completion derives
expected rows from the plan. `bench:public --allow-added-workloads` permits an
explicit comparison to an older result, marks added rows as lacking a baseline
and still rejects missing/changed old workloads. Default comparisons remain
strict.
The comparison validates all rows before printing ratios and rejects duplicate
workload identities on either side. Four focused protocol tests cover matching,
added, removed, changed and duplicate rows and incompatible engines/clocks.

## Production evidence so far

The reconstructed staging baseline and optimized applet used the same suite,
128 MiB benchmark I/O budget, fixed files, three samples and independent runs.
The optimized 1,000-file deletion workflow also passes a correctness test under
the default 32 MiB shell I/O budget.

| Shell operation, 1,000 files | Baseline median ms | Candidate run 1 | Candidate run 2 |
| --- | ---: | ---: | ---: |
| Initial add | 4720 | 3797 | 4533 |
| Unchanged add | 2704 | 140 | 217 |
| One-file add | 367 | 76 | 85 |
| Deleted-file staging | 10723 | 67 | 96 |

Raw production records: [baseline](cf-baseline.json),
[candidate](cf-git-candidate.json), [repeat](cf-git-repeat.json).
These are Worker-to-DO RPC wall times, not CPU or native Git timings. Initial
staging improvement is small relative to CF variability; unchanged and deletion
staging improvements repeat strongly.

An append query-fusion experiment saved one SQL statement but did not improve
local timing reliably and did not remove CF stalls in two production runs.
It also grew the core bundle by 1,242 bytes. It was reverted; raw evidence is
[local](append-local.json), [CF candidate](cf-append-candidate.json), and
[CF repeat](cf-append-repeat.json). The rejected patch is retained separately.
New constant-cost and chunk-reconfiguration tests remain useful independently.

A new staging path using the engine's public GitIndexManager was rejected
before implementation: importing that manager alone grew the browser bundle
from 539,292 to 572,605 bytes, exceeding the unchanged 563,968-byte Git budget.

The local-transfer candidate reuses scoped directory kind metadata instead of
repeating lstat per Git object. [Paired local results](git-transfer-paired.json)
use three warmups and ten alternating pairs, validate cloned bytes and all
repository heads, and fingerprint the two changed compiled modules. The
[CF transfer baseline](cf-transfer-baseline.json) has 118 rows and 27,048
assertions. The [first CF candidate](cf-transfer-candidate.json) passed all 27,048
assertions, with mixed wall-time results: bare clone 237→207 ms, worktree
clone 2703→3280 ms, fetch 63→66 ms, push 78→79 ms and pull 1728→1053 ms.
A second independent run is in progress; these medians alone do not establish
a production speedup.

Full `npm run check` passed after splitting append-specific tests into their own
file. The 12 bundle budgets remain unchanged; core VFS, default shell and
registry are 207,465, 235,191 and 502,036 bytes respectively. Append stalls and
slow initial add/worktree materialization remain improvement targets. R2 and
external network Git are outside these workloads.

## Additional staging-cache candidate

Inspection and mutation now share the existing command-local index cache.
[Ten paired trials](git-stage-cache-paired.json) show one-file add 6.40→6.11 ms
and 62→61 SQL calls, but other staging operation intervals overlap equality.
Thirty focused Git/public-workflow tests passed. This is a small candidate,
currently local only; full checks and CF evaluation remain pending.

## Removal-only batch candidate and demo verification

Removal-only selections can use batches of 256 because no input bodies or
compression streams are held. Mixed selections and blob staging remain bounded
to 32. [Ten paired trials](git-delete-batch-paired.json) reduce staging 999
remaining removals from 17.85 to 7.75 ms (ratio interval 0.380–0.441), and
632→100 SQL calls. Full `npm run check` passed. The old transfer implementation
plus these staging changes is now deployed as a CF control; evaluation pending.

The second transfer-candidate CF run again had mixed timings and slower
worktree clone. A fresh old-transfer control is necessary before deciding
whether that is caused by the candidate. Raw repeat:
[cf-transfer-repeat.json](cf-transfer-repeat.json).

[Live public shell smoke transcript](public-shell-smoke.txt) confirms init,
identity configuration, commit, bare/worktree clone, changed commit, push and
fast-forward pull. The copied file read back `second`, `SMOKE_OK` was emitted,
and the unique temporary workspace directory was removed. This exercised
production deployment a610952e-b99c-4680-b383-e0316c544f80.

## Rejected binary-digest probe

A proposed lazy binary-digest optimization was based on an incorrect initial
reading: incomingDigest already returns without hashing unless skipIfUnchanged
is true. The change only removed an empty async call. [Paired results](byte-digest-local.json)
showed binary overwrite 18.16→17.88 ms with unchanged 7,000 SQL calls, insufficient
benefit to grow the core by 20 bytes. It was reverted without production
deployment. A binary digest/ownership/unchanged-write correctness test passed
and remains independently useful. Revalidation after asynchronous collection
was never disabled.

## Missing-ignore probe candidate

The matrix inspection repeatedly probes the same absent .gitignore and
.git/info/exclude paths for every new file. A bounded negative-probe cache
exists only within this read-only inspection phase (128 paths per operation).
Successful results are removed immediately; rule bodies are not retained.
Each cached probe still performs the cancellation/step check. Host serialization
of Git commands with repository edits remains the documented requirement.

[Ten paired local trials](git-ignore-paired.json) reduce initial staging
251.19→188.41 ms and SQL calls 33,726→22,733. Other operation intervals overlap
no change. Full checks passed; a new nested-ignore creation/removal test and
30 existing Git/public workflow tests passed. Git preset 540,554/563,968 bytes;
core VFS/default shell/default registry sizes remain unchanged. CF deployment
and repeat local measurements are in progress.

The quiet [repeat local comparison](git-ignore-paired-repeat.json) confirmed
initial add 237.64→170.54 ms, paired ratio interval 0.702–0.738, with the same
SQL reduction. The candidate is deployed as 3643f8d6-692c-4fbe-8339-562f0cc80733,
build 7ec1780768a0799b75a8bcfd817229c63c2fe165ec566aebbed238eb98fd9982.
CF candidate run is in progress. Nested ignore-rule tests and quality checks
passed. Prior staging-only [CF repeat](cf-staging-final-repeat.json) passed all
27,048 assertions.

## Default-mode write candidate

Git's scoped FS pre-inspected every write merely to decide whether to supply
creation mode. For the VFS default 0644, omission already creates that mode and
preserves existing permissions. The fast path omits the option and redundant
inspection only when the umask-derived mode is exactly 0100644. Other umasks
and executable modes retain inspection. Actual write authorization, mutation
budgets and VFS publication checks are unchanged.

[Paired transfer measurements](git-write-transfer-paired.json): bare clone
75.18→65.71 ms (20,158→18,143 SQL calls), worktree clone 157.79→136.89 ms
(37,315→33,301 calls). Fetch/push/pull intervals overlap equality. The
[paired staging run](git-write-staging-paired.json) saves 1,025 SQL calls during
initial add but has noisy timing. Existing permission, symlink and executable
mode cases plus new existing-config/index and 077/002 execution-umask cases pass.
Full check passes: 1,878 Node + 137 workerd tests, POSIX 46/46, 12 bundle presets.
Git is 540,574 bytes within the unchanged budget; core presets do not grow.
CF deployment is pending completion of the current ignore repeat job.

## Single-file removal candidate

Public shell-workflow removal of 1,000 files has consistently taken about
3 seconds. It exercises single-file VFS.remove calls in a populated Git
namespace. These calls unnecessarily used subtree/chunk-range deletion.
The candidate reuses existing removeExact for non-directories, keeps the
original removal event shape, advances the exact tombstone version and records
one exact absent path. Directory removal retains the set-based path. Existing
hard-link, open-inode, sticky-bit, symlink, opaque-object and rollback tests
remain required. No new filesystem API is introduced.

An initial version duplicated a removal event; the event regression caught it.
A second version preserved events but workerd metering exposed 1,010 billed
rows for a removal amid 1,000 unrelated files. Exact-path publication resolves
that scan. The new workerd guards pass for 100 and 1,000 unrelated bodies with
5–10 statements and at most 40 billed rows, validating remaining bodies and
removed-file absence. Initial measurements are kept as rejected intermediate
experiments; [current paired measurement](remove-paired.json) is authoritative.
Full checks, structural benchmark guards and CF deployment are in progress.

The Git shell benchmark now awaits each file removal so asynchronous failures
cannot be lost. Public-workflow tests passed. Current write-path CF evidence:
[run 1](cf-git-write-candidate.json); a second run is active. Deployment
3572585d-6514-4c34-bb8d-b299057dee7a,
build cc0902fc36a3dcf930fb2279dc46b68c0cfbf940c96dd619b4fa6396b2a1663f.

The corrected removal candidate [paired experiment](remove-paired.json) reduced
1,000 removals amid 4,000 unrelated bodies from 363.30→11.38 ms, ratio interval
0.0308–0.0322, SQL calls 11,999→9,000 and returned rows 2,999→1,000. These
returned rows are not Cloudflare billed rows. New workerd billed-row guards
pass independently. Full checks pass with 1,878 Node + 139 workerd tests,
POSIX 46/46 and all bundle budgets. `npm run bench:check` also passed
17 Node and 31 workerd performance cases. Core VFS grew 256 bytes to 207,721,
within its unchanged 213,504-byte budget. CF deployment awaits completion of
the current write-path repeat job.

### Production removal result

The exact-removal candidate passes 27,048 assertions in each of two CF runs.
For 1,000 file removals, prior write-only builds measured 3,195/3,541 ms;
[removal run 1](cf-remove-candidate.json) measured 142 ms (160/142/104), and
[removal run 2](cf-remove-repeat.json) measured 94 ms (94/143/69). This large
improvement repeats under RPC wall timing. Git deletion staging remains a
separate operation. Deployment c334fd2a-dd93-4478-b660-51dbad784c4d,
build 2c13facee1a0fda55badc96cd9ce41c9ad68a40b3513102515a35f61326c564f.

## Bounded checkout candidate

The applet now probes the engine's existing nonBlocking checkout option,
limiting batches to four file operations. This targets serialized native
compression/decompression waits on CF; it adds no filesystem API. Dirty-tree,
fast-forward-only and dry-run protection remain. A new four-file, 3 MiB each
clone passes default shell I/O budgets and validates every byte. Full checks
pass. [Paired Node results](git-checkout-paired.json) show no clear worktree
clone improvement (137.82→137.54 ms), with unchanged SQL calls. The hypothesis
requires actual CF evidence; production deployment is in progress.

## Latest actual filesystem versus SQLite VFS

[Raw probe](git-native-vfs-latest.json) and [summary](git-native-vfs-summary.json)
use Node v24.18.0 on Apple M5 Max, same isomorphic-git 1.43.1 engine, 1,000 files,
two warmups and five measured trials, instrumentation disabled. The native arm
uses the macOS temporary filesystem; both share a local HTTP Git remote. These
are direct-engine results, not the shell applet or CF CPU timings. Median ms:

| Operation | Actual filesystem | SQLite VFS |
| --- | ---: | ---: |
| Populate | 78.27 | 20.71 |
| Initial add | 137.40 | 120.15 |
| Initial commit | 4.56 | 3.28 |
| Clean status, first pass | 20.21 | 20.32 |
| One-file add | 1.43 | 1.22 |
| Checkout old | 16.74 | 27.55 |
| Checkout main | 17.84 | 27.46 |
| Push | 175.40 | 137.10 |
| Clone | 138.30 | 132.76 |

The remaining local direct-engine gap is checkout (about 1.5–1.6×), while
many other operations are similar or faster on VFS in this environment. The
probe also reproduces the engine's known same-second stat-cache limitation;
the shell applet independently hashes actual bytes to avoid that behavior.

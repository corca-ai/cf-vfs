# Changelog

Notable changes to `@corca-ai/cf-vfs`, in the format of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The major version is zero, so a breaking change raises the **minor** version
and everything else raises the patch version. Breaking entries are marked.

An entry says what changed and why in a sentence or two; the linked pull
request carries the reasoning, the measurements, and the alternatives that were
rejected.

Entries under **Unreleased** are on `main` and have not been released, so a
consumer installing from a git reference already has them — breaking changes
included.

## [Unreleased]

- Speed up fresh local Git clones with guarded recursive object copying and
  bounded checkout writes. An optional `canUseBulkOperation` hint preserves
  collaborative overlays and falls back to individual I/O when unsupported.

- Reuse directory-entry metadata during local Git object transfers to avoid
  duplicate per-object SQL lookups in clone, fetch and push.

- Isolate Git checkout metadata lock paths so an interrupted checkout cannot
  block same-path operations in another filesystem or after a Durable Object reset.


### Added

- Git `checkout --force REF` / `-f` explicitly restores tracked files and the
  index after a partial checkout while ordinary checkout retains dirty-tree
  protection.

- Optional `availableWriteBufferBytes` reports inline buffer headroom so callers
  can plan bounded `writeFiles` batches without changing atomicity or quotas.

- An [optional Git applet](docs/git.md) supplies repository editing commands and
  local clone/fetch/push/fast-forward pull through the shell's scoped VFS.
  The Git engine is an optional peer dependency and excluded from default
  shell/VFS bundles. The public demo explicitly enables the command.

### Changed

- Git diff avoids decoding unchanged stored blobs and bounds worktree body
  comparisons. The demo serializes shell commands, editor changes and deferred
  publication in one room queue, acknowledges edits and subscribes open readers.
  The [evaluation](bench/git-recovery-coordination-2026-10-09/report.md) records
  recovery and concurrency tests and measured diff performance.

- Git add persists bounded sets of loose objects using existing `writeFiles`
  before publishing the index. Small sets and backends without sufficient
  reported buffer headroom keep individual writes. The
  [API experiments](bench/git-api-experiments-2026-10-09/report.md) record
  measured gains and rejected engine and metadata API candidates.

- Optional Git staging skips unchanged files, confines traversal to selected
  paths, shares command-local index state and batches index deletions. Missing
  ignore-file probes are reused during inspection; default-mode Git writes
  avoid duplicate existence lookups. The
  [evaluation](bench/cf-improvement-2026-10-09/report.md) records local and
  repeated Cloudflare measurements.
- Whole-worktree Git staging skips comparison reads for new blobs, extends
  small-body batches within a 1 MiB inspected total, and shares overlapping
  configuration reads without caching completed values. Worktree body collection
  and hashing use a per-inspection concurrency limit. The
  [evaluation](bench/git-add-optimization-2026-10-09/report.md) records repeated
  CF measurements and preserves scoped I/O accounting.
- Deletion-only Git staging groups up to 1,024 paths per index serialization,
  without expanding blob/compression concurrency or adding filesystem APIs. The
  [follow-up evaluation](bench/git-add-next-2026-10-09/report.md) records actual
  CF phase profiling, alternating controls and rejected body/hash reuse experiments.
- Up-to-date local Git pull skips checkout and reference publication after
  fetching and verifying a clean tree and index.
- Single-file VFS removal uses exact entry deletion and path publication;
  recursive directory removal retains the set-based implementation.

- Canonical short ASCII paths avoid normalization allocations, small whole-file
  reads combine entry and body retrieval, and directory creation avoids a
  duplicate lookup. No filesystem API is added. The
  [ten-round CF evaluation](bench/cf-optimization-2026-10-08/report.md) records
  accepted and rejected candidates, production samples and storage costs.

- Optional filesystem metadata caching retains independent entries across
  existing-file content writes while preserving whole-cache invalidation for
  permission/namespace changes and oversized working sets. No filesystem API
  is added. The [evaluation](bench/public-benchmark-evaluation-2026-10-08.md)
  records the measured scope and the rejected checkout optimizations.

- String `writeFiles` batches collect synchronously and reuse owned UTF-8 chunk
  views instead of copying the encoded body again. Unchanged string writes also
  reuse these views during hashing, while retaining commit-time validation and
  the existing byte budgets. The [evaluation](bench/extension-write-optimization-2026-10-08.md)
  records the measured latency and unchanged SQL costs.

### Fixed

- Reopening stored inline data with a different chunk size preserves overwrite
  and append behavior. Full overwrites remove actual stored tail chunks,
  append uses the stored width, and hard links and existing streams retain
  their expected identity and bytes.

- Failed incoming digest computation releases collected write buffers for both
  single and batch writes, preventing subsequent writes from failing against a
  leaked in-flight byte reservation.

## [0.4.2] — 2026-10-08

### Added

- Optional `/fs`, `/fs/metadata`, and `/fs/content` entry points provide a
  promise filesystem subset, bounded metadata reuse, and immutable large-body
  access while preserving separate VFS and shell dependency graphs. The
  [independent evaluation](bench/fs-evaluation-2026-10-08.md) records measured
  costs, compatibility limits, and rejected optimization attempts.

### Changed

- Descriptor operations reuse inode metadata within one operation, shrinking
  truncate deletes chunks in sets, and full-chunk writes skip discarded bodies.
  File namespace mutations avoid directory nlink recounts, and known unshared
  inodes skip alias queries. The [five-trial evaluation](bench/posix-perf-five-2026-10-08.md)
  records independent and combined measurements with the Linux semantic oracle.

- Filesystem metadata separates ctime from mtime and updates parent directories.
  Local descriptors share inode contents through rename/unlink, support bounded
  positional I/O and storage synchronization, and hard links share identity.
  Opaque publication guards symlink/dot traversal; opaque append streams a full
  replacement. The [completion evaluation](bench/posix-completion-2026-10-08.md)
  records compatibility, performance costs, and remaining immutable-store limits.

- Credential-bound stat combines indexed ancestor and target reads, replacement
  rename reuses its destination row, and the Node testing adapter reuses bounded
  prepared statements. The [POSIX evaluation](bench/posix-evaluation-2026-10-08.md)
  records all ten experiments, Linux semantic differences, and runtime-specific
  performance measurements.
- Development checks share boundary-case catalogs and record jq failure answers
  from its pinned image. Local performance comparison freshly builds a baseline
  commit and alternates paired measurements with reproducible metadata.
  ([#122](https://github.com/corca-ai/cf-vfs/pull/122))
- The demo uses its document registry as the single owner of open documents;
  moved or removed documents reconcile publication timers from registry state.
  ([#122](https://github.com/corca-ai/cf-vfs/pull/122))

### Fixed

- VFS and promise-FS paths resolve links before dot components, reject missing
  or non-directory prefixes, and preserve traversal permission and mutation
  guards. Metadata reuse cannot replace these paths with lexical lookups.
  Opaque writes decline dot paths whose traversal guard cannot be reserved.
  The [follow-up evaluation](bench/posix-path-fix-2026-10-08.md) records semantic
  and performance comparisons.
- File creation, uploads, copy, and move now respect missing-directory assertions
  in VFS paths. Byte ranges consistently use validated own fields in SQLite,
  R2, and the in-memory opaque store. ([#121](https://github.com/corca-ai/cf-vfs/pull/121))
- Shell, AWK, and regular-expression nesting fail with bounded diagnostics before
  exhausting the stack. Link creation obeys mutation budgets and checks the
  destination link without following its target; saved curl responses obey
  memory limits and cancel unused bodies. ([#121](https://github.com/corca-ai/cf-vfs/pull/121))
- jq preserves runtime errors through alternatives, handles array entries and
  null values correctly, and validates numeric conversions and flatten depths.
  sort keeps unterminated file operands separate, and xargs preserves empty
  NUL-delimited arguments while enforcing its record limit. ([#121](https://github.com/corca-ai/cf-vfs/pull/121))

## [0.4.1] — 2026-09-13

### Fixed

- Metadata-only filesystems no longer repeatedly schedule overdue body-deletion
  alarms when `opaqueStore` is absent. They preserve queued bodies for a
  configured collector while continuing upload and receipt expiry maintenance.
  The deployed benchmark now connects its alarm collector to its R2 bucket.
  ([#120](https://github.com/corca-ai/cf-vfs/pull/120))

## [0.4.0] — 2026-09-05

### Added

- An opt-in, tree-shakable `awkCommand` implements a bounded streaming AWK
  profile with `BEGIN`/`END`, pattern-action rules, fields and record counters,
  associative arrays, range patterns, loops, expressions and accumulation,
  `if`, `next`, `exit`, `print`/`printf`, `split`/`match`/`sub`/`gsub`, and
  VFS-backed `-f` programs, verified against a pinned BusyBox 1.37.0 oracle.
- Bash compatibility Version 5 adds `set --`, `$*`, scalar `${!name}`
  indirection, plain `read` backslash processing, the
  single-equals and variable-existence double-bracket tests, and atomic combined
  `&>`/`&>>` redirection without adding OS
  process semantics.

### Changed

- SQL batches flush workspace usage once, string appends avoid a repeated
  metadata lookup, and find queries seek from their cursor and narrow eligible
  scans before materializing rows. Schema version 8 adds indexed maintenance
  minima; GC queue inserts trade one additional index write for bounded alarm
  scheduling reads. See [the SQL measurements](bench/sql-optimizations-2026-09-05.md).
- Exact-string POSIX patterns use native string search after dialect validation;
  boolean regex searches skip captures and reuse bounded matching states.
  Sed checks ordinary replacement strings as a whole instead of per character.
  See [the second text-processing pass](bench/text-processing-follow-up-2026-09-05.md)
  for incremental Node/workerd measurements against `6fa62a3`.
- Repeated POSIX regex searches read code points directly from the source
  instead of rebuilding whole-input arrays and translating offsets on each
  match. Short ASCII byte-length checks avoid encoding. Local Node/workerd
  benchmarks retain the existing SQL, execution-limit, and bundle budgets;
  see [the text-processing measurements](bench/text-processing-2026-09-05.md).
- **Breaking:** Collaborative view mutation tokens now include document versions.
  Read/modify/write callers must carry tokens from the same view. Deferred
  writes require backend `InlineWriteValidator` support (provided by SQL and
  credential-bound views). Writes racing a reopened or edited document fail
  with `EREVISION`; reconciliation preserves disjoint changes and reports
  overlapping edits without discarding either version. See
  [the collaboration contract](docs/collaboration.md).

### Fixed

- Long name filters retain JavaScript matching when their SQL prefilter would
  exceed Durable Object SQLite's 50-byte GLOB pattern limit.
- Batch entry quotas include automatically created parent directories and
  roll back the entire batch when those parents take it over the limit.
- Preserve unseen stored document changes across metadata updates; accept
  link-chain guards for permission, ownership, and timestamp mutations.
- Correct unified-patch empty-range positions and avoid argument-stack overflows
  when diffing or patching large files. Reject invalid public stream limits
  before collection, including chunk sizes that previously looped forever.
- Bound discarded sed substitutions, in-place output, and rebuilt AWK records.
  Stop cancelled network requests before dispatch and release responses from
  hosts that cancel while starting a request.
- Correct non-BMP subtree path translation, final R2 verification expiry checks,
  jq binding order, and the documented original-text `TextEdit` offsets.
- Bound glob backtracking, jq synchronous work and intermediate allocations,
  and AWK scalar strings. Add external-watchdog and boundary regression checks.

## [0.3.0] — 2026-08-28

### Changed

- The POSIX shell profile now supports `cut` position ranges and `-s`, the
  integer `printf` conversions with widths, precisions, and flags, and `sed -E`
  and addressed `q`. `grep` and `sed` share the documented bounded POSIX basic
  and extended regular-expression semantics.
- `digestFile(path)` now exposes one revision-stamped SHA-256 primitive shared
  by inline bodies, verified opaque objects, `skipIfUnchanged`, and
  `sha256sum`. A cold inline digest populates the private cache without
  changing observable metadata; later calls read one row and no body.
- **Breaking: `countSubtree(path)` is now `subtreeSummary(path)`.** The same
  unbounded indexed aggregate now returns entry count, inline logical bytes,
  and all regular-file logical bytes, allowing `du` and recursive mutation
  budgets to share one constant-result query instead of materializing a tree.
- `readFile(path, { range })` now supports offset/length and suffix byte ranges
  for inline SQLite bodies, matching the existing opaque R2 range capability.
  `head -c`, `tail -c`, and inline `wc -c` use the common shape to avoid
  materializing bytes they cannot consume.

### Fixed

- `jq` now rejects unescaped control characters in JSON strings instead of
  accepting input that JSON and the reference utility both reject.
- Byte-range validation now reads only an option record's own fields, so an
  inherited `offset`, `length`, or `suffix` cannot silently select file bytes.
- Document registry move handling now closes open destination entries replaced
  by the move before relocating any open source documents.
- Metadata mutations on open documents now advance their registry token while
  preserving pending text and report the pending size in their returned stat.
- Collaborative `lstat` now reports pending document size for a regular file,
  matching `stat` and collaborative reads.
- Collaborative write results now report the byte size produced by the merging
  document rather than assuming it exactly matches the requested replacement.
- Streamed collaborative writes now recheck which document is open after body
  collection, preventing an edit from landing in a document closed meanwhile.
- A write routed through an open document now applies its requested file mode
  and carries the resulting namespace token into the later publication.
- An identical write routed through an open document now advances the
  registry's publication token, so the next real edit can still be published.
- Writes routed through an open document now enforce mutation-token guards and
  create-only disposition before applying edits.
- Credential-bound collaborative writes now enforce file write permissions
  before changing an open document.
- Collaborative reconciliation now keeps locally merged text pending when a
  document's result differs from the storage snapshot it just incorporated.
- Collaborative publication now keeps edits made while a write is in flight
  pending for the next publication instead of incorrectly marking them clean.
- Collaborative directory traversal now reports the byte size of pending
  document text, matching `stat` and the bytes a collaborative read serves.
- `subtreeSummary` includes nested synthetic entries such as `/dev/fd/0`
  instead of counting only a reserved directory and its immediate children.
- Filtered root `findPage` traversal now waits until the stored-row scan reaches
  a reserved path before merging it, preventing synthetic entries such as
  `/dev` from repeating across pages.
- Root `find` results now reapply their result ceiling after reserved paths are
  merged with stored entries, so synthetic roots cannot overflow `limit`.
- Direct `find` calls on reserved directories now honor their result limit and
  starting cursor instead of returning every synthetic match.
- Direct `find` traversal of reserved paths now applies `maxDepth` and
  `pathGlob` instead of returning synthetic descendants that do not match.
- `findPage` now honors limits and cursors when traversing a reserved directory
  directly, rather than materializing every synthetic child at once.
- `listPage` now honors limits and cursors when listing a reserved directory
  such as `/dev`, instead of returning all synthetic entries in one page.
- `basename` and `dirname` now process path text lexically, preserving `..`
  components and accepting an empty operand instead of canonicalizing through
  the virtual root.
- `du` now measures a named symbolic link itself instead of following a
  directory link and charging the target subtree.
- `ln -s TARGET` now strips trailing slashes when inferring the link name while
  preserving the target text stored in the link.
- `ln -s TARGET` no longer treats its inferred link name as a second directory
  operand, preventing an existing `./basename(TARGET)` directory from receiving
  an unintended nested link.
- Opaque commits that fail a local filesystem precondition now release their
  verification lease, allowing an immediate retry after the parent or quota is
  repaired instead of returning `EAGAIN` until lease expiry.
- Change-feed pagination now keeps every path from a set-based mutation on the
  same page, preventing a numeric cursor from skipping the remainder of a
  recursive copy, move, or removal when it crosses the requested limit.
- Copying a missing path onto itself now reports the missing source instead of
  a same-path conflict that presupposes an entry exists.
- A same-path `move` now verifies that its source exists instead of reporting a
  successful no-op for a path absent from the filesystem.
- Moving a missing source to a path lexically below it now reports the missing
  source instead of misclassifying it as a directory moved into itself.
- RPC record validation now rejects structured-clone built-ins such as `Map`
  and `Date` instead of silently treating them as empty option or environment
  records.
- Shell RPC execution now rejects permission masks above `0777` at the input
  boundary instead of ignoring them without credentials or failing later with
  a credential-bound filesystem.
- Malformed bodies in `writeFiles` now identify the failing entry index and
  field instead of reporting only a context-free `body` error.
- RPC option records and retained opaque-upload receipts are now rebuilt from
  parsed fields instead of asserted wholesale. A damaged receipt missing its
  entry identity can no longer escape as a complete `OpaqueFileStat`, and
  malformed shell environment or argument values remain unknown until each
  value has been validated.

## [0.2.0] — 2026-08-27

### Removed

- **Breaking: the `ifRevision` write guard.** It was validated against the path
  a write *resolved* to, so repointing a path through a symbolic link between
  reading a revision and writing let the guard accept a write to a file the
  caller never named. A revision cannot express what the guard needs: the row
  carrying it is destroyed by a removal, and nothing on it records that a path
  became a link. Use `ifMutationToken`, which composes the workspace epoch with
  the version of every path crossed and survives both. `revision` remains on
  every result as an observable. ([#109])

### Added

- **POSIX permissions and credential-bound views.** `forCredentials({ uid, gid,
  supplementaryGids }, { umask })` returns an immutable access-controlled
  `VirtualFileSystem`; the raw object stays the trusted administration
  capability. ([`97800a8`])
- **A durable identity for every entry, in the `st_ino` position.** A caller
  keying durable state to a file — a per-file room, a watcher, an index row —
  had nothing to key to but the path, and a path changes. `VfsStat` now carries
  `ino`, stable across moves, renames and content replacement, and never
  reissued. ([#96])
- **`statById(ino)`**, so an identity can be turned back into a path or
  reported gone. `ino` was previously write-only: it came out of every result
  and nothing took one back. Trusted capability only — a credential-bound view
  refuses it, because identities are consecutive and reading by one would let
  any credential enumerate the workspace by counting. ([#112])
- **`writeFiles(entries, options)`**, which commits a set of writes as one
  change. `copy`, `move` and `remove` were already atomic however many entries
  they touch; writing distinct bodies to distinct paths was not, so a failure
  partway left a tree matching nobody's intent. Every body is collected first,
  then the set commits in one transaction. ([#114])
- **`skipIfUnchanged` on `writeFile`**, which publishes nothing when the body
  is already exactly what is stored. For a caller flushing a derived snapshot
  on a timer: the write is cheap, and what costs is the revision bump that
  invalidates every other holder's guard on that path. ([#91])
- **`vfs.mutation` events**, reporting each committed namespace change to a
  host maintaining a view of the workspace. Previously `vfs.usage` was an
  aggregate gauge and a mutation token answered only about a path already
  named, which left polling as the only option. ([#92])
- **An opt-in change cursor, `changesSince`**, for a host that was disconnected
  when the changes happened and would otherwise have to re-read the namespace.
  Off by default and free when off. ([#93])
- **`@corca-ai/cf-vfs/collab`**, the editing layer between a workspace and an
  editing session, behind its own subpath and asserted absent from every bundle
  preset — a consumer that does not edit collaboratively carries none of it.
  ([#94])
- **Quotas that can move while the object is hot.** `maxInlineLogicalBytes` and
  `maxEntries` accept `number | (() => number)`, read on every check, so a host
  keeping limits in a plan or tenant record can raise one without waiting for
  the object to be evicted. ([#104])
- **External identity-name resolution in the shell**, so `ls -l`, `stat`, `id`
  and `groups` can report host account names rather than bare numbers.
  ([`859e8c3`])
- **This changelog**, shipped in the package alongside `docs/`, so the history
  is available to a consumer without leaving the install.
- **Demo:** a shell running under a named POSIX identity ([`a335bd1`]), and a
  browser editor beside the terminal where a `sed -i` arrives as an edit rather
  than overwriting what someone is typing ([#95]).

### Changed

- **Breaking: the in-flight byte budget distinguishes its two refusals.**
  Exceeding `maxInFlightBufferedBytes` was always `ENOSPC`, whether the call's
  own demand could never fit or it had merely lost a race with a concurrent
  read snapshot. It is now `ENOSPC` when the caller's own demand exceeds the
  whole budget — split the request, retrying is work with no outcome — and
  `EAGAIN` when it would have fitted and can be retried. A consumer branching
  on `ENOSPC` for contention has to accept `EAGAIN` too. ([#114])
- **Quota refusals refuse only growth.** A mutation that holds usage steady or
  gives space back is now allowed even when the workspace is already past a
  quota, because writing less is how a workspace gets back under one. ([#104])
- **`skipIfUnchanged` decides from a recorded digest** rather than by reading
  and comparing the stored body, so the cost of deciding that nothing changed
  no longer follows the size of the file. Internal and never reported.
  ([#111])
- **Fewer SQL statements and rows on the common paths**, without changing what
  any of them answer. ([`1a4447d`], [#86])

### Fixed

- **Maintenance alarms are scheduled earliest-wins.** A Durable Object has one
  alarm and the composition the README recommends shares it, so last-writer-wins
  scheduling silently deleted a host's alarm or moved it out. ([#90])
- **A path's revision only moves forward.** Three of the five places where an
  entry lands on an occupied path started a fresh revision instead of
  continuing the one already there, so a revision could go backwards.
  ([#110])
- **`cp` over an existing file keeps the destination's identity**, as
  `writeFile` and `mv` already did. It was the one of the three replacement
  routes that retired the entry and issued a new identity. ([#101])
- **A replacing copy no longer double-counts the destination** in workspace
  usage totals, which had drifted the byte and entry counts. ([#103])
- **The version-5 identity migration comment describes what the migration does**,
  and the never-reuse invariant is guarded by a test rather than only by a
  comment. ([#100])
- **Demo:** the disk-usage example. ([#85])

## [0.1.0] — 2026-07-29

Packaging only, with no source change: a built tarball of [`32a2c15`] attached
to the release, so the package can be installed by a consumer that pins
`ignore-scripts=true` and therefore never runs the `prepare` script that builds
`dist/`.

[#85]: https://github.com/corca-ai/cf-vfs/pull/85
[#86]: https://github.com/corca-ai/cf-vfs/pull/86
[#90]: https://github.com/corca-ai/cf-vfs/pull/90
[#91]: https://github.com/corca-ai/cf-vfs/pull/91
[#92]: https://github.com/corca-ai/cf-vfs/pull/92
[#93]: https://github.com/corca-ai/cf-vfs/pull/93
[#94]: https://github.com/corca-ai/cf-vfs/pull/94
[#95]: https://github.com/corca-ai/cf-vfs/pull/95
[#96]: https://github.com/corca-ai/cf-vfs/pull/96
[#100]: https://github.com/corca-ai/cf-vfs/pull/100
[#101]: https://github.com/corca-ai/cf-vfs/pull/101
[#103]: https://github.com/corca-ai/cf-vfs/pull/103
[#104]: https://github.com/corca-ai/cf-vfs/pull/104
[#109]: https://github.com/corca-ai/cf-vfs/pull/109
[#110]: https://github.com/corca-ai/cf-vfs/pull/110
[#111]: https://github.com/corca-ai/cf-vfs/pull/111
[#112]: https://github.com/corca-ai/cf-vfs/pull/112
[#114]: https://github.com/corca-ai/cf-vfs/pull/114
[`97800a8`]: https://github.com/corca-ai/cf-vfs/commit/97800a8
[`859e8c3`]: https://github.com/corca-ai/cf-vfs/commit/859e8c3
[`a335bd1`]: https://github.com/corca-ai/cf-vfs/commit/a335bd1
[`1a4447d`]: https://github.com/corca-ai/cf-vfs/commit/1a4447d
[`32a2c15`]: https://github.com/corca-ai/cf-vfs/commit/32a2c15
[Unreleased]: https://github.com/corca-ai/cf-vfs/compare/v0.4.2...HEAD
[0.4.2]: https://github.com/corca-ai/cf-vfs/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/corca-ai/cf-vfs/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/corca-ai/cf-vfs/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/corca-ai/cf-vfs/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/corca-ai/cf-vfs/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/corca-ai/cf-vfs/releases/tag/v0.1.0

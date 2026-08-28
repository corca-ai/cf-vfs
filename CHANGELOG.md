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

### Changed

- **Breaking: `countSubtree(path)` is now `subtreeSummary(path)`.** The same
  unbounded indexed aggregate now returns entry count, inline logical bytes,
  and all regular-file logical bytes, allowing `du` and recursive mutation
  budgets to share one constant-result query instead of materializing a tree.
- `readFile(path, { range })` now supports offset/length and suffix byte ranges
  for inline SQLite bodies, matching the existing opaque R2 range capability.
  `head -c`, `tail -c`, and inline `wc -c` use the common shape to avoid
  materializing bytes they cannot consume.

### Fixed

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
[Unreleased]: https://github.com/corca-ai/cf-vfs/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/corca-ai/cf-vfs/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/corca-ai/cf-vfs/releases/tag/v0.1.0

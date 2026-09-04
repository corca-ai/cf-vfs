# Collaborative documents

The optional `/collab` entry point routes writes to open inline UTF-8 documents
and serves unpublished text, including ranged reads and digests. The host owns
the `CollaborativeDocument` implementation and calls `registry.markDirty(path)`
synchronously after every edit made outside the collaborative filesystem.

Register a document with the text and mutation token from the same underlying
storage read. `publishedText` is the common base for later reconciliation.
`OpenDocument.token` remains a storage token used to recognize publication events.
Tokens returned by the collaborative view's reads, stats, writes, and
`getMutationToken()` also cover the document version. Treat them as opaque and
use them with the view that issued them.

Read/modify/write callers must pass the view's token as `ifMutationToken`.
Editing the document, reopening it, or moving its path invalidates that token.
A stale write fails with `EREVISION` before changing the document. Unguarded
writes explicitly replace current text; they do not identify which earlier
snapshot a caller intended to edit. A document changed or reopened while a
write body was being collected also causes `EREVISION`.

Deferred writes require the underlying filesystem's optional
`InlineWriteValidator` capability. The SQL backend and its credential-bound
views implement it, so both orders of wrapping enforce the same write
permissions and disposition rules. A backend without this capability returns
`ENOTSUP` for a deferred write. Validation occurs before consuming the body and
again against its final UTF-8 size. File and workspace quotas include pending
growth in other registered documents. This is validation, not a storage
reservation: publication still validates the actual storage state. A mode
option follows the backend's write rules, including preserving an existing
file's mode for credential-bound writes.

`publish(path)` captures text and a storage guard. Edits arriving while it waits
remain dirty and visible for a later publication. Closed or reopened entries
cannot be marked saved by an older operation. Wire committed mutation events
to `registry.observe(event)`: removal closes affected documents, while movement
relocates them and causes the next publication to verify the stored base and
refresh the destination token.

`reconcile(path)` compares the published base, local document, and current
storage. Disjoint line edits merge. Overlapping changes return `EREVISION`
while preserving local text, dirty state, and the external stored version.
The demo reports save conflicts to watching clients. This layer does not ship
a CRDT or silently choose between conflicting versions. Hosts must resolve the
conflict explicitly before retrying.

`TextEdit` offsets always refer to the original text and are sorted and
non-overlapping. Use `applyTextEdits`, apply edits from last to first when
mutating text directly, or account for the cumulative offset delta. Deriving
a diff alone does not make a stale whole-text replacement safe.

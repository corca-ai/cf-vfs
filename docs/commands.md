# Commands and API

These commands borrow familiar Unix names but are structured application APIs,
not complete POSIX or GNU/BSD utility implementations. See the
[POSIX-style compatibility profile](posix-compatibility.md) for the exact
boundary.

Each command lives in its own side-effect-free module and exports two entry
points:

- `runLs`, `runGrep`, and similar typed functions for direct composition;
- `lsCommand`, `grepCommand`, and similar definitions for the generic executor,
  including runtime input validation.

Prefer imports such as `@corca-ai/cf-vfs/commands/ls` over the all-command
barrel when bundle size matters. The package declares `sideEffects: false`.

## Executor contract

`CommandExecutor.execute()` and the Durable Object `execute()` RPC accept:

```ts
interface ExecuteRequest {
  command: string;
  cwd?: string;
  input?: unknown;
  stdin?: string;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  output?: "both" | "structured" | "text";
}
```

The result contains `exitCode`, `stdout`, `stderr`, structured `data`, and a
`truncated` flag. Unknown commands return 127, invalid command input returns 2,
and filesystem failures return 1. Commands can also return a meaningful
non-zero status without a filesystem failure: `test` returns 1 for a false
predicate, `grep` returns 1 for no matches, and `cmp`/`diff` return 1 for
different content. Text output defaults to 1 MiB and has an 8 MiB hard cap. Use
`output: "text"` when structured search results would only duplicate a large
stdout response.

`stdin` is an explicit string for commands that consume text input. It defaults
to empty and is never populated by an implicit pipeline. Input defaults to a 1
MiB byte limit and has an 8 MiB hard cap; oversized input is rejected with
`E2BIG` rather than truncated. A caller can compose commands by explicitly
passing one result's `stdout` as the next request's `stdin`.

Structured filesystem errors expose a code and optional canonical path.
Common codes include `ENOENT`, `EEXIST`, `ENOTDIR`, `EISDIR`, `ENOTEMPTY`,
`ENAMETOOLONG`, `EFBIG`, and `ENOTSUP`. `EREVISION` and `ENOTTEXT` describe
library-specific revision and text-content constraints; `E2BIG` is used for
bounded command or search inputs rather than filesystem capacity.

## Supported commands

| Module | Important input | Semantics and implementation |
| --- | --- | --- |
| `ls` | `path`, `all`, `long` | Direct-child indexed metadata query; never reads bodies. |
| `stat` | `path` or `paths` | Kind, content kind, bytes, lines, mode, timestamps, and revision. |
| `find` | `path`, `type`, `name`, `pathGlob`, `maxDepth`, `limit` | Indexed path-range scan followed by glob and depth filters. |
| `pwd` | none | Returns the executor's normalized current working directory. |
| `basename`, `dirname` | `path`; optional `suffix` for `basename` | Lexical POSIX-style path component transforms. They do not access the filesystem. |
| `realpath` | `path`, `requireExists` | Resolves a canonical absolute VFS path. Existence is required by default; there are no symlinks to traverse. |
| `test` | `path`, `predicate`, `negate` | Tests `exists`, `file`, `directory`, `text`, `binary`, or `nonempty`; false is exit status 1 rather than an error. |
| `tree` | `path`, `maxDepth`, `limit` | Bounded recursive tree display with structured entries and truncation metadata. |
| `du` | `path` or `paths`, `maxDepth`, `limit` | Sums logical file bytes from metadata without reading file bodies. |
| `cat` | `path` or `paths` | Concatenates logical text files regardless of SQL chunk count. |
| `head`, `tail` | `path` plus either `lines` or `bytes` | Reads only enough leading or trailing chunks. Byte slices round inward to valid UTF-8. |
| `grep` | `pattern`, `paths`, `fixed`, `ignoreCase`, `include`, `maxResults` | Recursive line-oriented fixed or regex search with path, line, and column output. |
| `sed` | `path`, `pattern`, `replacement`, `fixed`, `global`, `ifRevision` | Atomic whole-file replacement with an optional revision guard. |
| `diff` | `from`, `to`, `maxBytes` | Bounded UTF-8 line comparison with a compact zero-context unified-style output. It is not a patch-format compatibility promise. |
| `cmp` | `from`, `to`, `maxBytes` | Streaming byte comparison for text or binary files. Different content returns exit status 1 with the first differing byte and line. |
| `patch` | `path`, `patch` or text/stdin, `ifRevision` | Applies a bounded, single-file unified-diff subset atomically. Every context/deletion line must match and writes use a revision guard. |
| `wc` | `path` or `paths`, `lines`, `words`, `bytes` | POSIX-style newline, word, and UTF-8 byte counts. |
| `sha256sum` | `path` or `paths`, `maxBytes` | Computes SHA-256 over exact file bytes. Binary R2 bodies are consumed through a digest stream. |
| `write` | `path`, `text`, `createParents`, `ifRevision`, `mode`, `disposition` | Atomic text write. `disposition` is `create`, `replace`, or the default `upsert`. |
| `tee` | `paths`, text or stdin, `append`, `createParents`, `ifRevision` | Writes bounded input to one or more text files and echoes it. A revision guard requires exactly one target. |
| `mkdir` | `path` or `paths`, `parents`, `mode` | Directory creation with `mkdir -p` semantics and optional compatibility mode metadata. |
| `touch` | `path` or `paths`, `create`, `createParents`, `ifRevision`, `mode`, `modifiedAtMs` | Creates empty text files or updates metadata without rewriting existing bodies. |
| `chmod` | `path` or `paths`, `mode`, `ifRevision` | Changes permission-shaped metadata while preserving file-type bits. It does not enforce access control. |
| `mktemp` | `template`, `directory`, `createParents`, `mode` | Exclusively creates a randomized file or directory. The template ends in at least six `X` characters. |
| `cp` | `from`, `to`, `createParents` | Text-only copy; a directory destination receives the source basename. |
| `mv` | `from`, `to`, `replace` | Atomic rename of a file or subtree within one Durable Object. Replacement is opt-in and requires compatible file/directory kinds and an empty destination directory. |
| `rm` | `path` or `paths`, `recursive` | Removes SQL state and deletes or durably queues R2 objects. |
| `rmdir` | `path` or `paths` | Removes empty directories and rejects regular files. |
| `sort` | `text` or stdin, `ignoreCase`, `numeric`, `reverse` | Stable whole-line sort using deterministic Unicode string order or numeric values. |
| `uniq` | `text` or stdin, `count`, `ignoreCase` | Collapses adjacent equal lines, optionally prefixing occurrence counts. |
| `cut` | `text` or stdin, `delimiter`, `fields` | Selects 1-based delimiter-separated fields; lines without the delimiter pass through. |
| `tr` | `text` or stdin, `from`, `to`, `delete` | Translates or deletes explicit Unicode code points. Ranges and character classes are not expanded. |
| `nl` | `text` or stdin, `all`, `start`, `increment`, `width`, `separator` | Numbers non-empty lines by default with configurable numbering metadata. |
| `paste` | `texts`, `delimiter`, `serial` | Combines bounded text inputs by corresponding lines or serially. |
| `comm` | `left`, `right`, suppression flags, `checkOrder` | Produces three logical columns for two sorted bounded text inputs. Ordering is checked by default. |
| `join` | `left`, `right`, `delimiter`, `leftField`, `rightField`, `unpaired`, `maxRows` | Bounded equi-join over exact-delimiter fields, including duplicate-key Cartesian pairs and optional unpaired rows. |
| `fold` | `text` or stdin, `width`, `spaces` | Folds lines by Unicode code-point count, optionally at whitespace. It does not calculate terminal display width. |

The text-transform commands use an explicit `text` field when supplied and
otherwise consume `stdin`. Their input is checked against the executor's input
limit. Line-oriented transforms preserve whether the original input ended in a
newline; empty input remains empty. They operate on JavaScript Unicode strings,
not locale-specific byte collation, and intentionally implement only the
options listed above.

`paste`, `comm`, and `join` accept multiple explicit text values and apply the
same input limit to their combined UTF-8 byte size. `comm` uses deterministic
JavaScript string ordering. `join` accepts one exact, non-empty delimiter rather
than locale-dependent blank-field parsing.

`patch` accepts one file and one patch document. It supports standard unified
hunk headers, context/add/delete lines, and the no-final-newline marker, but not
multi-file patches, renames, binary patches, fuzz, or offset guessing. This
strict subset prevents a patch from silently applying to unexpected content.

This is a command API, not a shell interpreter. It intentionally has no string
parser, process spawning, pipes, redirection, environment expansion, or command
substitution. An agent can use returned text as the next structured request's
input without exposing a shell-injection surface.

## Binary methods

Binary bodies are not exposed through the text commands. The Durable Object
base class provides:

```ts
putBinary(path, bytes, { createParents?, mode? })
readBinary(path, { offset, length } | { suffix })
readBinaryStream(path, { offset, length } | { suffix })
drainBinaryGarbage(limit?)
```

Binary creation is immutable. An existing path cannot be overwritten, searched,
or edited. Remove the old path and create a new generation-specific object when
the application wants replacement semantics.

`readBinary()` materializes its selected range as an `ArrayBuffer` for
compatibility. `readBinaryStream()` transfers an R2 byte stream over Workers
RPC with flow control, so large or slow consumers do not require whole-object
buffering. Cancelling the receiving stream propagates to its source.

## Paginated filesystem reads

The filesystem and Durable Object base class expose `listPage(path, options)`
and `findPage(options)`. Both accept a `limit` of at most 1,000 and an opaque
`cursor`, and return `entries`, `scanned`, and `nextCursor`. `findPage` limits
raw paths scanned in a page before applying type, depth, name, and path filters,
so a filtered page can contain fewer entries or even be empty while still
returning a continuation cursor.

Cursors are keyset positions, not snapshots. Callers must treat them as opaque
and continue until `nextCursor` is null.

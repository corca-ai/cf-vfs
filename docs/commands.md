# Commands and API

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
  maxOutputBytes?: number;
  output?: "both" | "structured" | "text";
}
```

The result contains `exitCode`, `stdout`, `stderr`, structured `data`, and a
`truncated` flag. Unknown commands return 127, invalid command input returns 2,
and filesystem failures return 1. Text output defaults to 1 MiB and has an 8
MiB hard cap. Use `output: "text"` when structured search results would only
duplicate a large stdout response.

## Supported commands

| Module | Important input | Semantics and implementation |
| --- | --- | --- |
| `ls` | `path`, `all`, `long` | Direct-child indexed metadata query; never reads bodies. |
| `stat` | `path` or `paths` | Kind, content kind, bytes, lines, mode, timestamps, and revision. |
| `find` | `path`, `type`, `name`, `pathGlob`, `maxDepth`, `limit` | Indexed path-range scan followed by glob and depth filters. |
| `cat` | `path` or `paths` | Concatenates logical text files regardless of SQL chunk count. |
| `head`, `tail` | `path` plus either `lines` or `bytes` | Reads only enough leading or trailing chunks. Byte slices round inward to valid UTF-8. |
| `grep` | `pattern`, `paths`, `fixed`, `ignoreCase`, `include`, `maxResults` | Recursive line-oriented fixed or regex search with path, line, and column output. |
| `sed` | `path`, `pattern`, `replacement`, `fixed`, `global`, `ifRevision` | Atomic whole-file replacement with an optional revision guard. |
| `wc` | `path` or `paths`, `lines`, `words`, `bytes` | POSIX-style newline, word, and UTF-8 byte counts. |
| `write` | `path`, `text`, `createParents`, `ifRevision`, `mode` | Atomic create or replacement of one UTF-8 text file. |
| `mkdir` | `path` or `paths`, `parents` | Directory creation with `mkdir -p` semantics. |
| `cp` | `from`, `to`, `createParents` | Text-only copy; a directory destination receives the source basename. |
| `mv` | `from`, `to` | Atomic rename of a file or subtree within one Durable Object. |
| `rm` | `path` or `paths`, `recursive` | Removes SQL state and deletes or durably queues R2 objects. |

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
drainBinaryGarbage(limit?)
```

Binary creation is immutable. An existing path cannot be overwritten, searched,
or edited. Remove the old path and create a new generation-specific object when
the application wants replacement semantics.

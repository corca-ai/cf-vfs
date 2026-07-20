# Shell, commands, and direct API

The primary command interface is Bash-compatible source, not a JSON dispatcher.
`BASH_COMPATIBILITY_VERSION` is currently `1`.

## Execution APIs

```ts
import { Shell } from "@corca-ai/cf-vfs/shell";
import { catCommand, findCommand } from "@corca-ai/cf-vfs/shell/commands";
import { lsCommand } from "@corca-ai/cf-vfs/shell/commands/ls";

const shell = new Shell({
  fileSystem,
  commands: [catCommand, findCommand, lsCommand],
});

const execution = shell.executeStream({ script, cwd, env, args, stdin });
const [stdout, stderr, status] = await Promise.all([
  new Response(execution.stdout).text(),
  new Response(execution.stderr).text(),
  execution.completed,
]);
```

Consume stdout and stderr concurrently before awaiting `completed`; an
unconsumed output correctly applies backpressure. `cancel(reason)` cancels the
whole execution. Deadline, idle-output, intermediate, and output limits fail
instead of returning a valid truncated prefix.

`executeText()` concurrently drains both streams and returns decoded strings;
`executeBytes()` returns exact byte arrays without also allocating strings.
Both apply a shared 8 MiB materialized-output limit by default. Use them only
when bounded materialization is appropriate. `ShellDurableObject`
also provides `executeTo({ script, stdin, stdout, stderr })` for the remote
stream boundary.

Shell-domain failures resolve to statuses so `||` can handle them. An
unexpected command/runtime invariant rejects `completed`.

| Outcome | Status |
| --- | ---: |
| success | 0 |
| false `test`, no `grep` match, `cmp`/`diff` difference | 1 |
| syntax or usage error | 2 |
| command unavailable by policy | 126 |
| command not found | 127 |

## Bash Version 1

Supported syntax:

- simple commands, assignment-only commands, and command-prefix assignments;
- single quotes, double quotes, and backslash escapes;
- `$VAR`, `${VAR}`, `$?`, `$0`, `$1...`, `$@`, and `$#`;
- newlines, `;`, `&&`, `||`, and prefix `!`;
- concurrent pipelines;
- `<`, `>`, `>>`, `2>`, `2>>`, and left-to-right `2>&1`;
- pathname expansion with `*`, `?`, and bracket/range expressions;
- comments beginning with `#` at a word boundary.

The complete submitted script is parsed before any command runs. Unsupported
parenthesized syntax, command substitution, parameter operators, arrays,
extended `[[ ]]`, brace expansion, arbitrary descriptors, background jobs,
reserved control syntax, and malformed redirection produce status 2 before a
partial mutation.

Pipeline stages receive cloned shell state; an ordinary single built-in uses
parent state. Assignment-only commands persist. Command-prefix assignments are
recognized before expansion, their right-hand sides do not split or glob, and
normally restore after a command. Consecutive assignment-only right-hand sides
observe earlier assignments. `export` and
`unset` mutate parent state outside a pipeline. `set -o pipefail` and
`set +o pipefail` are supported.

A downstream normal early close maps the upstream edge's `EPIPE` to status 0.
Consequently `cat large | head -n 1` remains successful under `pipefail` while
real non-zero upstream statuses are still selected from right to left.

See [POSIX and Bash compatibility](posix-compatibility.md) for deterministic
locale, glob, and redirection details and [the parser spike](parser-spike.md)
for parser selection.

## Built-ins and utilities

The default registry is available only from
`@corca-ai/cf-vfs/shell/commands/default`. Applications should normally build
the smallest registry they need. The dedicated `ls` subpath and ordinary
`cat`/`grep` barrel imports are covered by bundle tests proving unrelated
command implementations are absent; the default preset is covered separately.

| Group | Commands and principal Version 1 options |
| --- | --- |
| shell | `:`, `true`, `false`, `echo -n`, `printf` (`%s`, `%d`, `%b`), `pwd`, `cd`, `export`, `unset`, `exit`, `set -o pipefail`, `test`, `[` |
| namespace | `mkdir -p -m`, `touch -c`, `rm -r -f`, `rmdir`, `mv -f`, `cp -r -f`, `ls -l -d`, `find -name -type -maxdepth`, `stat`, `chmod`, `du`, `tree`, `basename`, `dirname`, `realpath`, `mktemp`, `file` |
| streaming text/bytes | `cat`, `grep -i -v -n -F -c`, `head -n -c`, `wc -l -w -c`, `uniq -c`, `cut -d -f -c`, `tr`, `nl`, `fold -w`, `sed s/old/new/[g]` |
| bounded barriers | `sort -r -u -n`, `tail -n -c`, `tee -a`, `paste`, `cmp`, `diff`, `sha256sum`, `comm -1 -2 -3`, `join -t -1 -2 -a`, `patch` |

Text utilities use fatal incremental UTF-8 decoding unless the operation is
explicitly byte-based. Invalid UTF-8 is `EIO`. `cat`, byte `head`, byte `wc`,
and `cmp` preserve arbitrary bytes. Line length and record count are bounded
independently from byte count. Commands batch small output into roughly 64 KiB
slabs. `sort`, `tail`, `paste`, `diff`, `comm`, `join`, `patch`, hashing, and
atomic VFS commits buffer only at their semantic barriers.

Named utilities implement the documented subset, not every GNU/BSD option.
Unsupported options are usage errors rather than silently ignored behavior.

## Opaque behavior

Opaque files are normal regular files for pathname and metadata operations but
their bodies are absent from the shell capability object.

| Operation | Behavior |
| --- | --- |
| `ls`, `stat`, `find`, `tree`, glob, `du`, `test -f`, `file` | metadata only; succeeds |
| `touch`, `chmod`, `mv` | SQLite metadata/namespace only |
| `cp` | creates another metadata reference; no R2 body transfer |
| `rm` | unlinks and durably queues the last unreachable generation |
| `cat`, text `head`/`tail`, `grep`, `sort`, `sed`, `cut`, `tr`, `nl`, `fold` | `ENOTSUP` before R2 read |
| `cmp`, `diff`, `patch`, `join`, `comm` | `ENOTSUP` if an opaque body is required |
| `sha256sum` | emits a trusted verified digest; otherwise `ENOTSUP` |
| `>>` and append `tee` | `ENOTSUP` |
| `>` | atomically replaces the entry with bounded inline bytes and queues old R2 content if unreachable |

`readOpaque()` and upload lifecycle methods remain on the programmatic VFS;
they are not present on `ShellCommandContext.fileSystem`.

## Direct VFS primitives

`VirtualFileSystem` operates on bytes and canonical paths:

- `stat`, `list`/`listPage`, and `find`/`findPage`;
- `readFile`, `writeFile`, `appendFile`, `touch`, and `setMetadata`;
- `mkdir`, `remove`, `move`, and `copy`;
- `getMutationToken` and optional revision/token guards;
- `beginOpaqueUpload`, `commitOpaqueUpload`, `abortOpaqueUpload`;
- `resolveOpaqueRead` and `drainGarbage`.

Inline `readFile()` returns a stable bounded stream snapshot. Consume or cancel
it to release the instance-wide materialization budget. Writes accept strings,
buffers, typed views, or byte streams and publish once after normal collection.

Pagination cursors are keyset positions, not durable snapshots. Continue
through empty filtered pages until `nextCursor` is null. A concurrent mutation
before the cursor can be missed; restart when a fresh complete traversal is
required.

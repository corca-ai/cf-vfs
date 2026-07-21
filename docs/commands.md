# Shell, commands, and direct API

The primary command interface is Bash-compatible source, not a JSON dispatcher.
`BASH_COMPATIBILITY_VERSION` is currently `2`.

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

## Bash Version 2

Supported syntax:

- simple commands, assignment-only commands, and command-prefix assignments;
- single quotes, double quotes, and backslash escapes;
- `$VAR`, `${VAR}`, `$?`, `$0`, `$1...`, `$@`, and `$#`;
- newlines, `;`, `&&`, `||`, and prefix `!`;
- concurrent pipelines;
- ordinary groups `{ list; }` and isolated subshells `(list)`;
- `if`/`elif`/`else`, `while`, `until`, `for name [in words]`, and `case` with
  `;;` terminators;
- `name() compound-command` functions plus `local`, `return`, `break`, and
  `continue`;
- `$(script)` command substitution;
- `${name-word}`, `${name:-word}`, `${name=word}`, `${name:=word}`,
  `${name+word}`, `${name:+word}`, `${name?word}`, `${name:?word}`, and
  `${#name}` parameter expansion;
- signed 64-bit `$((expression))` expansion and `((expression))` commands,
  including integer variables, assignment/update, arithmetic, comparison,
  bitwise, logical, conditional, and comma operators;
- `<`, `>`, `>>`, `2>`, `2>>`, left-to-right `2>&1`, `<<`, `<<-`, and `<<<`;
- pathname expansion with `*`, `?`, and bracket/range expressions;
- comments beginning with `#` at a word boundary.

The complete submitted script is parsed before any command runs. Unsupported
backticks, process substitution, C-style `for`, arrays, extended-test operators
outside the Version 3 `[[ ... ]]` profile, brace expansion, arbitrary
descriptors, background jobs, `select`, the
`function` keyword, `time`, `coproc`, and malformed syntax produce status 2
before a partial mutation. `eval`, traps, job control, shell options outside
the documented `pipefail` and Version 3 `nounset` profile, and OS process
features are unavailable commands or usage errors.

Pipeline stages receive cloned shell state; an ordinary single built-in uses
parent state. Assignment-only commands persist. Command-prefix assignments are
recognized before expansion, their right-hand sides do not split or glob, and
normally restore after a command. Consecutive assignment-only right-hand sides
observe earlier assignments. `export` and `unset` mutate parent state outside
a pipeline. `set -o pipefail` and `set +o pipefail` are supported. Version 3
also supports `set -u`, `set +u`, `set -o nounset`, and `set +o nounset`.

Ordinary groups and function bodies use the current session. Pipelines,
parenthesized subshells, and command substitutions clone variables, functions,
arguments, and working directory, so their changes do not escape. Functions
are definitions rather than registry commands: an allowlist may invoke a
defined function, but every utility reached by its body is still checked.

Command substitution inherits the current virtual stdin, sends stderr to the
current stderr, requires valid UTF-8 without NUL bytes, removes trailing
newlines, and is limited to 1 MiB by default. It is collected concurrently with
execution, so the pipe remains backpressured rather than deadlocking. Here
strings append one newline. An unquoted here-document delimiter enables
parameter, command, arithmetic, and backslash expansion; quoting any delimiter
character disables expansion, and `<<-` strips leading tab characters.

Arithmetic is deterministic two's-complement signed 64-bit arithmetic rather
than JavaScript number arithmetic. Invalid numeric text in a referenced shell
variable reads as zero. Division by zero and excessive exponents fail the
command; loops, function calls, nesting, and substitution output all have
explicit limits in [Operations and security](operations.md).

A downstream normal early close maps the upstream edge's `EPIPE` to status 0.
Consequently `cat large | head -n 1` remains successful under `pipefail` while
real non-zero upstream statuses are still selected from right to left.

### Version 3 work in progress

The default registry includes `source` and `.`. They resolve only explicit
absolute or `cwd`-relative VFS paths; there is no `PATH` search. A sourced file
must be inline, bounded valid UTF-8 without NUL, and is completely parsed before
that unit executes. It runs in the current session, so variables, functions,
options, and `cwd` changes persist. Supplied positional arguments are temporary,
`return` stops only the sourced unit, and `exit` retains whole-shell behavior.

Sourced units share cumulative source-byte, AST-node, execution, I/O, mutation,
deadline, and cancellation budgets with the caller. The exported compatibility
version remains 2 until every issue in the declared Version 3 profile is complete.

The default registry also includes the deliberately non-interactive

- `read -r [--] [name ...]`, which consumes one bounded UTF-8 record from fd 0,
  assigns `REPLY` without splitting when no name is supplied, and otherwise
  uses the fixed whitespace `IFS` profile. A final unterminated record is
  assigned with status 1; empty EOF assigns empty values with status 1. Other
  `read` options, prompts, timeouts, and backslash processing are unsupported.
- `shift [n]`, which atomically removes positional arguments in the current
  argument frame. The default is one, zero is allowed, and a count beyond `$#`
  returns status 1 without mutation.
- `getopts optstring name [args ...]`, which implements short option clusters,
  required arguments, leading-colon silent reporting, `OPTARG`, and `OPTIND`.
  It stops at a non-option or `--`; long options and optional arguments are not
  supported. Assigning `OPTIND=1` resets the hidden short-option cluster cursor
  even when its visible value was already 1. A function-local `OPTIND` gets its
  own cursor and restores the caller's cursor on return.

These built-ins mutate the current function or sourced-unit session. Pipeline
stages, subshells, and command substitutions receive the same cloned state as
the rest of the Version 3 runtime, so their argument and variable changes do
not escape. `read -r` retains bytes after its first newline for the next
consumer even when an upstream stream chunk contains several records.
At execution completion, any unread root stdin is cancelled so a retained
record suffix and an RPC producer cannot outlive the shell execution.

Version 3 also extends scalar parameter expansion with:

- `${name#pattern}`, `${name##pattern}`, `${name%pattern}`, and
  `${name%%pattern}` for shortest or longest prefix/suffix removal;
- `${name/pattern/replacement}` and `${name//pattern/replacement}` for the
  first or every non-overlapping match; and
- `${name:offset}` and `${name:offset:length}` for Unicode-code-point
  substrings.

The pattern language is the same bounded `*`, `?`, bracket/range, and escape
language used by pathname expansion, but it never scans the filesystem and has
no pathname-separator or leading-dot rule. Quoted pattern fragments are
literal. Pattern and replacement words may contain nested expansion before
matching. An omitted replacement deletes matches, and empty pattern matches do
not cause repeated insertions.

Substring operands trim surrounding whitespace and must then match the
nonempty strict-decimal form `-?[0-9]+`; explicit empty operands and a leading
`+` are rejected rather than interpreted as Bash arithmetic expressions. A
negative offset counts from the end and clamps to zero; a non-negative offset
past the end produces an empty value. Length must be non-negative. Negative
lengths, arrays, indirect expansion, extglob,
locale-dependent ranges, anchored replacement forms such as `${name/#p/r}`,
and special `&` replacement interpolation are unsupported. Unquoted results
then undergo the ordinary field-splitting and pathname-expansion phases.

Deterministic nounset handling is available through `set -u`, `set +u`,
`set -o nounset`, and `set +o nounset`. When enabled, a plain expansion of an
unset scalar, a missing positional parameter, length/pattern/substring
operations on an unset scalar, or an evaluated unset arithmetic reference
terminates the current shell scope with status 1 and an `unbound variable`
diagnostic. `&&`, `||`, `if`, and `!` do not suppress or catch that termination.
This matches the pinned Bash 5.3.3 stdin-script profile; Bash has
invocation-mode-specific exit-status differences that this runtime does not
reproduce.

Default, assignment, alternate-value, and error parameter operators still
handle unset values according to their declared semantics. Their operand words
remain lazy, so an unset reference in an unused word is not evaluated. Direct
arithmetic assignment can create a variable, and short-circuited arithmetic
branches are not read; updates and compound assignments read their target and
therefore fail when it is unset.

`$#` and `${#@}` report the positional-argument count. Plain `$@` remains safe
with zero arguments. Braced default and alternate forms treat zero arguments as
an unset `$@`; when arguments exist, forms that select `$@` preserve the
individual argument fields instead of joining them.

Functions, sourced units, and ordinary groups share option state and the
current shell scope. Subshells, multi-stage pipelines, and command
substitutions clone the option. An implicit nounset failure terminates only
such an isolated scope; its status can then participate in `||`, pipeline
status/`pipefail`, or command-substitution status in the parent. Option changes
inside an isolated scope do not escape.

The bounded `[[ ... ]]` compound conditional supports a nonempty word test;
unary `-n`, `-z`, `-e`, `-f`, and `-d`; string `==`, `!=`, `<`, and `>`;
strict-decimal integer `-eq`, `-ne`, `-lt`, `-le`, `-gt`, and `-ge`; and
prefix `!`, `&&`, `||`, plus parenthesized grouping. `&&` binds more tightly
than `||`, and both short-circuit. The complete conditional grammar is parsed
before execution, so missing operands, unmatched delimiters, and unsupported
operators cannot follow an earlier mutation in the same submitted unit.

Conditional operands use scalar expansion without field splitting or pathname
expansion. For `==` and `!=`, an unquoted right-hand fragment is the bounded
shell-pattern language; quoted or escaped fragments are literal. `<` and `>`
use deterministic UTF-8 byte order. Integer operands must be expanded
`-?[0-9]+` values; they are compared without a JavaScript-number range limit,
and invalid text is a status-2 semantic error. Unlike Bash arithmetic
conditionals, variable names and arithmetic expressions are not accepted as
integer operands.

`-e`, `-f`, and `-d` resolve canonical absolute or `cwd`-relative VFS paths.
An empty or missing path is false. Read-policy denial remains status 126 rather
than being hidden as false. Opaque R2 entries satisfy `-e` and `-f` from their
namespace metadata without reading their bodies. Regex `=~`, single `=`, and
inode, ownership, timestamp-order, device, socket, size, and permission tests
are rejected as unsupported syntax.

See [POSIX and Bash compatibility](posix-compatibility.md) for deterministic
locale, glob, and redirection details and [the parser spike](parser-spike.md)
for parser selection.

## Built-ins and utilities

The default registry is available only from
`@corca-ai/cf-vfs/shell/commands/default`. Applications should normally build
the smallest registry they need. The dedicated `ls` subpath and ordinary
`cat`/`grep` barrel imports are covered by bundle tests proving unrelated
command implementations are absent; the default preset is covered separately.

| Registry group | Available commands and principal options |
| --- | --- |
| shell | `:`, `true`, `false`, `echo -n`, `printf` (`%s`, `%d`, `%b`), `pwd`, `cd`, `export`, `unset`, `read -r`, `shift`, `getopts`, `source`, `.`, `local`, `return`, `break`, `continue`, `exit`, `set` (`-u`, `+u`, `-o/+o nounset`, `-o/+o pipefail`), `test`, `[` |
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

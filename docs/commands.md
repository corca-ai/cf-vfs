# Shell, commands, and direct API

The primary command interface is Bash-compatible source, not a JSON dispatcher.
`BASH_COMPATIBILITY_VERSION` is currently `4`.

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
| false `test`, no `grep` match, `cmp`/`diff` difference, utility failure including filesystem permission denial | 1 |
| syntax or usage error | 2 |
| command unavailable by shell policy or found but not executable | 126 |
| command not found | 127 |

## Interactive sessions

`InteractiveShell` is published only from
`@corca-ai/cf-vfs/shell/interactive`. It uses the same parser, evaluator,
commands, policies, budgets, descriptors, and VFS contract as `Shell`, while
preserving cwd, variables, functions, arguments, options, `getopts` state, and
the last status between complete submitted units:

```ts
import {
  InteractiveInputBuffer,
  InteractiveShell,
} from "@corca-ai/cf-vfs/shell/interactive";

const shell = new InteractiveShell({
  fileSystem,
  commands,
  env: { HOME: "/" },
});

await shell.runText({ script: "cd /repo; NAME=world" });
const result = await shell.runText({
  script: `printf '%s:%s' "$PWD" "$NAME"`,
});
// result.stdout === "/repo:world"
```

Use `runStream()`, `runText()`, or `runBytes()` for one complete source unit.
Only one unit may run per interactive session; an overlapping call fails with
`EAGAIN`. `exit` closes the session, after which submissions fail with
`EINVAL`. Each unit receives fresh virtual descriptors and a fresh execution
budget. Files persist because all units share the same VFS.

`InteractiveInputBuffer` classifies incomplete quotes, substitutions,
here-documents, conditionals, loops, functions, groups, and trailing
line-continuation backslashes so a terminal can display a continuation prompt.
Complete invalid syntax is submitted immediately and returns status 2.

### Completion

`InteractiveShell.complete(line, cursor)` offers what could come next: command
names in a command position, the `/bin` and `/usr/bin` spellings of them when
PATH lookup is on, environment variables after `$` or `${`, and namespace paths
everywhere else. It answers against the session's own working directory and
environment, so a completion reflects where the user actually is.

It is not a parse. Completion is asked for on lines that are usually
incomplete — that is when anyone wants it — so it reads backwards from the
cursor for a word and decides from what precedes it. A parser would refuse most
of the lines a user completes on.

Every search is bounded, and the bounds are visible in the result: candidates
returned, namespace entries examined across all pages, and the length of a word
worth working on. The result reports what it `scanned` so a caller can see the
cost of a keystroke, and sets `truncated` when a cap stopped it rather than
presenting a partial list as the whole answer. `commonPrefix` is computed over every match seen, including ones the caps kept
out of the returned list, so a client that types it never has to undo it.

The registry is an input, not a discovery: `completeShellLine` takes the
command names it should offer. `InteractiveShell` supplies the ones that would
actually resolve — the registry filtered by the command allowlist, plus this
session's shell functions and the `/bin` spellings, which resolve whether or
not PATH lookup is on. Discovery never advertises a name execution would
refuse. Nothing in completion imports the default registry, which is what keeps
every applet out of the bundle of a shell that registered three.

Completion reads through the same scoped filesystem an execution does, so it
cannot list a directory the session could not `ls`, and `/dev` paths complete
because that layer is in the stack too.

What it does not do is quoting. A word is matched literally, so a name
containing a space completes to text that the shell would then split, and
completing inside quotes or after a backslash escape finds nothing. `~` is not
expanded. These are worth knowing before building a client on it.

The `/shell` entry point does not re-export either interactive class.
Non-interactive consumers therefore do not bundle the persistent-session or
input-buffer layer. Both entry points share the single execution path in
`Shell`; interactive behavior is an adapter around a reusable `ShellSession`.

For repository development, `npm run repl` opens a session over
Node's built-in in-memory SQLite. `npm run repl:sqlite` starts local workerd
with a SQLite-backed Durable Object, stores its state in a temporary directory,
and removes that directory on exit. Both execute the same SQL VFS and use the
same terminal UI; the latter additionally exercises Cloudflare's storage and
RPC boundary. These are line-oriented language sessions, not OS TTYs: process
launching, job control, terminal modes, and curses applications remain
unavailable. VFS data is disposable in both modes; cwd, variables, functions,
and options remain runtime session state and reset if the process, local
Durable Object, or dev server restarts.

## Bash Version 4

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
- `<`, `>`, `>>`, `2>`, `2>>`, left-to-right `2>&1` and `>&2` (also spelled
  `1>&2`), `<<`, `<<-`, and `<<<`;
- pathname expansion with `*`, `?`, and bracket/range expressions;
- comments beginning with `#` at a word boundary.

The complete submitted script is parsed before any command runs. Unsupported
backticks, process substitution, C-style `for`, arrays, extended-test operators
outside the documented `[[ ... ]]` profile, brace expansion, arbitrary
descriptors, background jobs, `select`, the
`function` keyword, `time`, `coproc`, and malformed syntax produce status 2
before a partial mutation. `eval`, traps, job control, shell options outside
the documented `errexit`, `nounset`, and `pipefail` profile, and OS process
features are unavailable commands or usage errors.

Pipeline stages receive cloned shell state; an ordinary single built-in uses
parent state. Assignment-only commands persist. Command-prefix assignments are
recognized before expansion, their right-hand sides do not split or glob, and
normally restore after a command. Consecutive assignment-only right-hand sides
observe earlier assignments. `export` and `unset` mutate parent state outside
a pipeline. `set -o pipefail` and `set +o pipefail` are supported. Version 3
supports `set -u`, `set +u`, `set -o nounset`, and `set +o nounset`; Version 4
adds the four errexit forms documented below.

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

### Version 3 additions

The default registry includes `source` and `.`. They resolve only explicit
absolute or `cwd`-relative VFS paths; there is no `PATH` search. A sourced file
must be inline, bounded valid UTF-8 without NUL, and is completely parsed before
that unit executes. It runs in the current session, so variables, functions,
options, and `cwd` changes persist. Supplied positional arguments are temporary,
`return` stops only the sourced unit, and `exit` retains whole-shell behavior.

Sourced units share cumulative source-byte, AST-node, execution, I/O, mutation,
deadline, and cancellation budgets with the caller.

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

File predicates resolve canonical absolute or `cwd`-relative VFS paths.
An empty or missing path is false. Read-policy denial remains status 126 rather
than being hidden as false. Opaque R2 entries satisfy `-e` and `-f` from their
namespace metadata without reading their bodies. `-r`, `-w`, and `-x` use the
execution identity when present, as described below. Regex `=~`, single `=`,
and inode, ownership, timestamp-order, socket, and unsupported special-file
tests are rejected as unsupported syntax.

### Version 4 deterministic errexit

`set -e`, `set +e`, `set -o errexit`, and `set +o errexit` update the current
shell option. With errexit enabled, a non-zero pipeline status terminates the
current non-interactive shell scope with that exact status before the next
command. This is structured shell flow, not a runtime exception:
`execution.completed`, `executeText()`, and Durable Object RPC resolve normally
with the triggering status.

The baseline is the [GNU Bash `set -e` profile](https://www.gnu.org/software/bash/manual/html_node/The-Set-Builtin.html),
with the command-substitution rule described by Bash's
[`inherit_errexit`](https://www.gnu.org/software/bash/manual/html_node/The-Shopt-Builtin.html)
option made fixed and deterministic as described below.

Errexit is suppressed structurally for an `if`/`elif`, `while`, or `until`
condition; every non-final pipeline in an `&&` or `||` list; all but the final
stage of a pipeline; and a pipeline whose status is inverted with `!`. A
suppressed context propagates through brace groups, functions, sourced units,
and subshell bodies. Consequently, enabling `-e` inside a suppressed function
or compound command changes the option immediately but does not affect commands
in that invocation; it takes effect after the guarded command completes.
A non-subshell `if`, loop, `case`, or brace group that returns non-zero solely
because its last evaluated pipeline was suppressed preserves that provenance
and does not trigger again at its outer compound boundary. Function, source,
subshell, and multi-stage pipeline boundaries expose their returned non-zero
status as a new command or pipeline result and may trigger there.

Functions, brace groups, and sourced units share the caller's option. A
parenthesized subshell and each multi-stage pipeline stage clone it. Command
substitution deliberately follows default non-POSIX Bash: it clones the shell
session but clears inherited errexit. An explicit `set -e` inside the
substitution is effective there. Its failure status controls an assignment-only
command, but a surrounding command that succeeds still determines its own
status.

`pipefail` is applied before the parent decides whether to terminate, preserving
the rightmost non-zero stage status. Normal downstream early close remains
status 0. Explicit `return`, `exit`, `break`, and `continue` retain their own
flow; a non-zero function or source return can trigger errexit at its invocation
boundary. Nounset and fatal budget, deadline, cancellation, and output failures
remain unconditional failures rather than gaining errexit suppression.

Errexit cannot leave a command invocation until that invocation settles its
descriptors. Therefore a normally closed atomic redirection commits output
produced before an ordinary non-zero status, including the prefix written by a
compound command. Redirection open/close failure, mutation-token conflict,
cancellation, deadline, overflow, or runtime invariant failure keeps the
existing abort/discard behavior.

Only the four exact forms above are added. Combined flags such as `set -eu`,
option listings, `$-`, POSIX mode, `inherit_errexit`, `ERR` traps, and
`errtrace` remain unsupported.

See [POSIX and Bash compatibility](posix-compatibility.md) for deterministic
locale, glob, and redirection details and [the parser spike](parser-spike.md)
for parser selection.

### Environment ergonomics

An unquoted leading `~` expands to `HOME`: `~` and `~/path` only. Every other
form stays literal — `~user`, `~+`, `~-`, `~2` — which is what Bash does for a
name it cannot resolve and the only honest answer here, since there is no user
database. A tilde with `HOME` unset or empty stays literal too, a quoted tilde is
never expanded, and a tilde produced by an expansion is data rather than syntax.
A tilde whose prefix is continued by a quoted part or an expansion — `~"x"`,
`~$SUFFIX` — stays literal, because the prefix must end inside the written
literal for the shell to know it is one. The substituted value is treated as
quoted, as Bash does: it is a value, not syntax, so it is neither field-split
nor matched as a pattern, and a `HOME` holding `*` cannot turn `~/notes` into a
wildcard. Each substitution is charged to the expansion budget before it is
materialized, so a value naming many boundaries fails with a budget diagnostic
rather than building an unbounded string.

Any word shaped like an assignment expands a tilde after `=` and after each `:`,
so `PATH=~/bin:~/tools`, `PATH=$PATH:~/bin`, and `export PATH=~/bin` all work.
A `:` produced by an expansion is data and opens no boundary. The name before `=`
must be an identifier, so `--opt=~/y` and `9X=~/y` stay literal. A `case` word
and a `[[ ]]` operand expand a tilde as well; an unquoted default inside a
parameter expansion, such as `${X-~/d}`, does not.

`cd` maintains `PWD` and `OLDPWD`. `cd -` returns to `OLDPWD` and prints the
directory it moved to, as Bash does, and fails when there is no previous
directory. A bare `cd` uses `HOME` and fails when it is unset. Both failures are
usage errors with status 2 rather than Bash's 1, matching the profile's rule that
2 is a usage failure. A directory change persists in the caller's session from a
function, a group, and a sourced unit; a subshell, a pipeline stage, and an
executable script each clone the session, so their changes are discarded with the
clone.

`set` accepts clustered short flags and named options in one invocation:
`set -eu`, `set +eu`, `set -e -o nounset`, and `set -uo nounset` all work. `$-`
reports the options that are on, as `e` and `u` in that order. It lists only what
this profile spells as a short flag, so `pipefail` — which has no short form —
never appears, and neither do Bash's `h`, `B`, and `c`.

`test`, `[`, and `[[ ]]` all offer `-e`, `-f`, `-d`, `-s`, `-r`, `-w`, and
`-x`. With host-supplied execution credentials the permission predicates select
exactly one owner/group/other class; without credentials they preserve the
compatibility behavior of asking whether any class carries the bit. They do not
consult the shell's read and write roots: policy and DAC are independent
restrictions. `chmod` accepts symbolic clauses as well as an octal mode.

`id`, `id -u/-g/-G`, and `groups` inspect the numeric authorization identity
supplied by the host and fail when none was supplied. An optional
`ShellIdentityResolver` adds display names: plain `id` annotates IDs,
`id -un/-gn/-Gn` and `groups` print resolved names, and an unresolved display
name falls back to its numeric ID. The numeric forms never consult the
resolver. `chown` always accepts numeric `OWNER[:GROUP]`/`:GROUP` and also
accepts names when the resolver supplies the reverse mapping; the filesystem
still enforces root-only owner changes and limits an ordinary owner to its own
groups.

Plain `ls` remains one name per line. Its human-oriented long form is
`MODE OWNER GROUP SIZE NAME`; `ls -l` resolves owner and group names when the
host capability is present, while `ls -n` implies the long form and always
uses numbers. `stat -c %u/%g` is likewise always numeric, and `%U/%G` selects
resolved names with numeric fallback. `stat -c %i` reports the entry identity,
which is stable across a move and never reused after a removal. A device or an
applet path reports zero, because it has no entry behind it. The VFS has no
link count or change-time guarantee, so the long form does not invent those
Linux columns — a constant `1` for links would read as a fact rather than as
the absence of one.

`help` lists the registered commands with their summaries, `help NAME...`
describes named ones and exits 1 for an unknown one, and `help -s` prints only
the synopsis. It reads the active registry, so a narrow registry describes
exactly what it registered.

## Built-ins and utilities

The default registry is available only from
`@corca-ai/cf-vfs/shell/commands/default`. Applications should normally build
the smallest registry they need. The dedicated `ls` subpath and ordinary
`cat`/`grep` barrel imports are covered by bundle tests proving unrelated
command implementations are absent; the default preset is covered separately.

### Applet specifications and the multicall resolver

Every shipped command is an *applet*: one implementation described by a
declarative `AppletSpec` that carries the canonical name, any extra spellings,
the operand syntax used in a usage diagnostic, a one-line summary, and the
option table the applet scans. `@corca-ai/cf-vfs/shell/commands/applet` publishes
that contract — `defineApplet`, `parseAppletOptions`, `appletUsageError`,
`formatAppletUsage`, and `createAppletRegistry` — and imports no applet, so a
consumer can build its own registry without pulling the utility set.

`Shell` resolves a command name through that registry. A BusyBox-style multicall
lookup accepts the canonical name, any declared alias, and the virtual applet
directories `/bin` and `/usr/bin`, so `cat`, `/bin/cat`, and `/usr/bin/cat` are
the same implementation. Resolution is a literal directory-prefix match, never a
namespace lookup: no SQLite row or R2 object backs those spellings, a VFS file
written at `/bin/cat` does not shadow the applet, and an applet path performs no
storage work. Because the match is literal, a duplicated separator such as
`/bin//cat` does not resolve, and neither does any other absolute path: both
remain `command not found` with status 127.

Each applet declares how it participates in resolution:

| Kind | Bare name | Applet path | Examples |
| --- | --- | --- | --- |
| program | when the search is off, or when `PATH` names an applet directory | yes | `cat`, `grep`, `ls`, `env`, `which`, `printenv`, `sh` |
| built-in | always, whatever `PATH` says | yes | `echo`, `printf`, `pwd`, `test`, `[`, `true`, `false` |
| session built-in | always, whatever `PATH` says | no | `cd`, `export`, `set`, `source`, `.`, `read`, `command`, `type` |

This is Bash's rule: a built-in is found without a search, and a shell built-in
that changes the calling session has no program form at all, exactly as Linux
has no `/bin/cd`.

### PATH

The Linux search is opt-in. `ShellOptions.commandResolution` defaults to
`"registry"`, where every registered applet answers to its bare name and `PATH`
is an ordinary variable — so an application that sets `PATH` for its own reasons
cannot lose commands, and `type cat` reports an applet rather than inventing a
location. Set `commandResolution: "path"`, or spread `LINUX_SHELL_OPTIONS`, to
get the search.

Under the search, components are looked at left to right and the first match
decides. A component is normalized before it is classified, so `/bin/`, `//bin`,
and `/bin/.` are the applet directory they name and no stored file can answer in
their place. A duplicated component is harmless, and an empty component means
the working directory, as in POSIX. A prefix assignment applies before the
search, so `PATH=/opt/tools cat file` reports `cat: command not found` exactly as
in Bash. An absolute applet path bypasses the search entirely, under either
setting.

A name the command policy denies is reported as unresolved by `command -v`,
`type`, and `which`, so discovery never advertises something that would
immediately fail with 126.

A shell function takes precedence over an applet with the same bare name. As in
Bash, an applet path such as `/bin/echo` bypasses the function, and so does
`command echo`.

Diagnostics always name the canonical applet and end with its declared synopsis.
`ShellPolicy.allowedCommands` is matched against the canonical name, so one
allowlist entry covers every spelling of that implementation; entries must be
canonical applet names, since an alias in the list matches nothing.

`@corca-ai/cf-vfs/shell/linux` is an opt-in module supplying the locations and
variables ordinary scripts assume. It is a cf-vfs profile, not Linux and not the
Filesystem Hierarchy Standard: there is no built-in user database, package
manager, writable `/bin`, or host process. A host may separately attach a
`ShellIdentityResolver` for account-name presentation.

### Executable scripts

An inline VFS file whose effective mode includes an executable bit runs as a
shell script. `chmod +x script.sh` followed by `./script.sh` behaves the way it
does on Linux, and `sh script.sh` runs a file without requiring the bit.
`chmod` accepts an octal mode or comma-separated symbolic clauses matching
`[ugoa]*[-+=][rwx]*`; `s`, `t`, `X`, and numeric copies such as `u=g` are
outside the profile and are usage errors.

A pathname — anything containing `/` — names the file directly and is never
searched. A bare name is searched only under `commandResolution: "path"`, and
only through `PATH` components that are not applet directories: those already
answered, and no file can shadow an applet however the component is spelled.

A search skips a candidate that exists but cannot run and keeps looking, exactly
as Bash does, so one non-executable entry cannot mask a command a later
component provides; the refusal is reported only when nothing runs. A component
outside the readable roots supplies nothing at all, so it cannot turn an unknown
command into 126. An explicit pathname fails immediately, because there is
nothing else to try.

The interpreter line is read from a bounded 256-byte prefix before the file is
decoded. `#!/bin/sh`, `#!/bin/bash`, `#!/usr/bin/sh`, `#!/usr/bin/bash`,
`#!/usr/bin/env sh`, and `#!/usr/bin/env bash` all select this shell profile,
and a file with no interpreter line gets it too. Every other interpreter — and
any interpreter argument, such as `#!/bin/sh -e` — is refused, because there is
no process runtime to hand the file to and running it as something it did not
ask for would be worse than declining.

Statuses are Linux-shaped. A path that does not exist is 127. Everything else
that cannot run is 126: a directory or other non-regular entry, a file without
an executable bit, opaque R2 content, a file that is not valid UTF-8 or contains
a NUL byte, a file past the script byte limit, and an unsupported or malformed
interpreter line.

Execution creates an isolated child scope. It inherits the environment, working
directory, shell options, policy, cancellation, and the execution-wide budget,
and receives its own positional parameters with `$0` set to the spelling used to
invoke it, as Bash does.

The isolation is outbound only. Because there is no process boundary and one
variable map, a script also sees the caller's *unexported* variables, its shell
functions, and its options — a declared divergence from Bash, which inherits
only exported variables. Nothing the script defines, and no working-directory
change or `exit` it performs, reaches the caller, and `exit` ends the script
rather than the caller — an interactive session survives
a script that exits. Each script is parsed completely before it can mutate
anything, and nesting is bounded by `maxScriptDepth` independently of `source`.

When `ShellPolicy.allowedCommands` is set, one `sh` entry authorizes running
executable files, rather than requiring every script path an application might
store. `sh` and its `bash` alias run a bounded unit in that same isolated child
scope: `sh -c COMMAND [NAME [ARGUMENT...]]` or `sh FILE [ARGUMENT...]`. A named
file does not need the executable bit — naming the interpreter is the
authorization — and reports the same statuses an executable file does.
Interactive invocation, `-s`, `-l`, reading a script from standard input, and
job control are outside the profile.

### The Linux profile

`linuxShellEnvironment(options)` returns `PATH`, `HOME`, `USER`, `LOGNAME`,
`SHELL`, `TMPDIR`, `LANG`, `LC_ALL`, and `TZ`; pass it as `env`, and spread
`LINUX_SHELL_OPTIONS` into the `Shell` options to enable the search. `SHELL`
names `/bin/sh`, the canonical spelling of this shell profile. It claims no host
Bash: the declared language is `BASH_COMPATIBILITY_VERSION`.

`provisionLinuxFilesystem(fileSystem, options)` creates `/etc`, `/home`,
`/home/<user>`, `/tmp`, `/var`, `/var/tmp`, and `/workspace`, and returns what
it created. It is recursive and therefore idempotent. `/bin` and `/usr/bin` are
deliberately not created: they resolve applets without a namespace entry, so a
row there would mean nothing and could be removed while `/bin/cat` kept working.
Listing them is not supported, and a `home` or `cwd` option inside one is a
usage error.

`LINUX_PROFILE_VARIABLES` names what the profile sets. Seven of them are
defaults: a caller may override one by passing its own value after the
profile's, and a script may reassign it. `LC_ALL` and `TZ` are controlled — the
session sets them after the caller's environment, so they always read `C` and
`UTC`, which is the truth about a runtime whose collation and timestamps do not
follow them.

Nothing is `readonly`: this language has no such concept, and adding one would
create a restriction the shell cannot enforce anywhere else. What bounds a
reassignment instead is the execution unit. `Shell` builds a fresh session per
execution, so a script that overwrites `HOME` or `PATH` affects that unit only
and the next one starts from the profile again. `InteractiveShell` deliberately
persists a session, so there a reassignment lasts until the session ends.

`LinuxProfileOptions` accepts `user` (default `cf`), `home` (default
`/home/<user>`), `cwd` (default `/workspace`), and `tmp` (default `/tmp`). `cwd`
decides which directory is provisioned; pass the same path as the execution
`cwd` to start there.

| Registry group | Available commands and principal options |
| --- | --- |
| shell | `:`, `true`, `false`, `echo -n`, `printf` (`%s`, `%d`, `%b`), `pwd`, `cd -`, `export`, `env`, `unset`, `read -r`, `shift`, `getopts`, `source`, `.`, `local`, `return`, `break`, `continue`, `exit`, `set` (clustered `-eu/+eu`, `-o/+o errexit`, `-o/+o nounset`, `-o/+o pipefail`), `test`/`[` (`-e -f -d -s -r -w -x`, string and integer comparison), `id -u -g -G -n`, `groups` |
| discovery | `command -v`, `type`, `which`, `printenv`, from the dedicated `/shell/commands/discovery` subpath |
| help | `help -s`, from the dedicated `/shell/commands/help` subpath |
| shell profile | `sh -c`, `sh FILE`, and the `bash` alias, from the dedicated `/shell/commands/sh` subpath |
| namespace | `mkdir -p -m`, `touch -c`, `rm -r -f`, `rmdir`, `mv -f`, `cp -r -f -p -P`, `ls -l -n -d -a -A -1 -R`, `find -name -type -maxdepth -print -print0 -exec`, `stat -L -c` (`%i` identity, `%u/%g/%U/%G` ownership), `chmod`, `chown`, `du`, `tree`, `basename`, `dirname`, `realpath`, `mktemp`, `file` |
| links | `ln -s -f`, `readlink -f`, from the dedicated `/shell/commands/link` subpath |
| streaming text/bytes | `cat`, `grep -i -v -n -F -E -c -l -q -r -R -h`, `head -n -c`, `wc -l -w -c`, `uniq -c`, `cut -d -f -c`, `tr`, `nl`, `fold -w`, `sed -n -e -i`, `seq -s -w` |
| deterministic utilities | `date -u +FORMAT`, `sleep`, `expr`, from the dedicated `/shell/commands/system` subpath |
| bounded barriers | `sort -r -u -n`, `tail -n -c`, `tee -a`, `paste`, `cmp`, `diff`, `sha256sum`, `comm -1 -2 -3`, `join -t -1 -2 -a`, `patch`, `base64 -d -w` |
| argument dispatch | `xargs -n -0 -r -t`, from the dedicated `/shell/commands/xargs` subpath |

### Regular expressions

`grep` and `sed` take POSIX basic regular expressions, and `grep -E` takes
extended ones. Patterns are parsed and matched here rather than handed to the
JavaScript engine, so no JavaScript-only construct can mean something here that
it does not mean in `grep`: `a+` repeats in an extended expression and is a
literal plus in a basic one, and `(?:a)` does not open a non-capturing group.

`grep -o` prints the matched parts rather than the lines holding them, one to a
record, with the file name and `-n` line number repeated on each — which is
what makes it the way to pull a field out of a response without a parser. An
empty match is stepped over, so `-oE 'X*'` reports the runs and not the nothing
between them; `-c` still counts lines, and `-v` prints nothing because a line
reported for what it lacks has no matched part to show.

The declared subset is literals, `.`, `*`, bracket expressions with ranges and
POSIX character classes, the anchors `^` and `$`, grouping, alternation, `+`,
`?`, and the intervals `{n}`, `{n,}`, and `{n,m}` — spelled bare in an extended
expression and backslashed in a basic one. Back-references, the GNU extensions
`\w`, `\b`, `\<`, and `\>`, equivalence classes, and collating symbols are usage
errors rather than approximations. `-i` folds the twenty-six ASCII pairs only,
because the runtime declares `LC_ALL=C`: the Kelvin sign does not match `k`.

Matching runs a Thompson simulation, so the work is bounded by the record length
times the pattern size **however the pattern is written**. That bound is the
reason for the one visible divergence from GNU: alternation is leftmost-first
rather than POSIX leftmost-longest, so `sed 's/a\|ab/X/'` on `ab` gives `Xb`
where GNU gives `X`. Whether a record matches is unaffected; only which text a
group captures can differ. A backtracking engine would give leftmost-longest for
free, but it has no bound — `grep 'a*a*a*a*a*a*a*a*b'` against thirty-two
characters takes seconds — and a synchronous match cannot be interrupted by the
abort signal or the execution deadline, so one short pattern from a caller would
burn the whole CPU limit. Patterns that would still be large after expansion
(`(x{50}){50}`) are refused with status 2 rather than compiled.

### Opaque R2 content

`cat`, `head`, `grep`, and `wc` can stream an opaque R2 body when the host
supplies a content reader and the session's policy says `opaqueContent:
"stream"`. Both are required; either alone leaves the body unreadable, which is
the default every existing caller already has. `ls`, `stat`, and `file` name
and describe an opaque entry without either.

`sort`, `diff`, `patch`, `join`, `sed -i`, and command substitution keep
reporting `ENOTSUP` for an opaque body. They have to hold all of their input,
and a body is opaque because it was too large to hold — the refusal is what
keeps a script from dying against a limit halfway through instead of at the
start.

Nothing is materialized: at most one chunk is in flight, and a command that
stops early stops the read with it. `head -c N` asks the store for N bytes
rather than the whole body.

### The network capability and `curl`

`curl` is not in `defaultShellCommands`. It lives at
`@corca-ai/cf-vfs/shell/commands/curl`, and it reaches nothing on its own: every
request goes through a `ShellNetwork` the host supplies, and the session's
policy must say `network: "allow"`. Absent either, the command answers
`ENOTSUP` before a request is built. Both are required for the same reason
opaque content requires both — giving a host a network is not a decision about
every session running on it.

```ts
import { curlCommand } from "@corca-ai/cf-vfs/shell/commands/curl";

const shell = new Shell({
  fileSystem,
  commands: [...defaultShellCommands, curlCommand],
  network: {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.origin !== "https://api.example.com") {
        return new Response("origin not allowed", { status: 403 });
      }
      // Set rather than append, and after removing what the session sent: a
      // header the agent can add to is a header the agent controls.
      const headers = new Headers(request.headers);
      headers.delete("cookie");
      headers.set("authorization", `Bearer ${env.TOKEN}`);
      return fetch(new Request(request, { headers }), { redirect: "manual" });
    },
  },
  policy: { network: "allow" },
});
```

The credential never enters the session — see [credentials stay outside the
shell](operations.md#credentials-stay-outside-the-shell). That is also why
there is no `-u`: a credential a session can spell is a credential it can send
somewhere the host did not intend.

A session sets its own headers with `-H`, and nothing here filters them, so a
host that cares which value a header carries must set it rather than add to it.
Appending leaves the agent able to prepend its own — `authorization: Bearer
theirs, Bearer yours` is what an allowlisted API sees, and which one wins is the
API's business rather than the host's.

A request arrives with `redirect: "manual"`, and an implementation must keep it
that way. Following a redirect inside the host turns one authorized request
into an unbounded number of unauthorized ones; returning the redirect lets
`curl -L` come back through the same method, so the hop after an allowed origin
is checked like any other.

The option profile is deliberately small — enough to read an endpoint, post a
payload, save a body, and branch on the result:

| Option | Behavior |
| --- | --- |
| `-X`, `--request` | method; otherwise `HEAD` for `-I`, `POST` when `-d` is present, `GET` |
| `-H`, `--header` | repeatable; `Name: value` |
| `-d`, `--data` | repeatable, joined with `&`; sets a form content type unless one was given |
| `-o`, `--output` | write the body to a VFS path instead of standard output |
| `-i`, `--include` | prefix the body with the status line and headers |
| `-I`, `--head` | `HEAD`, headers only |
| `-f`, `--fail` | no body and status 22 when the response is 400 or above |
| `-L`, `--location` | follow redirects, each through the capability again |
| — | `authorization`, `cookie`, and `proxy-authorization` are dropped when a redirect changes origin |
| `--max-redirs` | how many, default 20 |
| `-s`, `-S` | accepted; there is no progress meter to silence |

Exit statuses follow curl where this profile can produce them: 3 for a URL that
is not one, 7 when the capability throws, 22 for `-f`, and 47 when `-L` runs out
of redirects. A usage error is 2, as everywhere else here.

Only `http` and `https` can be transferred, and a redirect cannot leave them:
a `Location: file:///…` is refused here rather than handed to a host that never
expected to have an opinion about it. Each hop is charged to the execution's
command budget and races its deadline, so a redirect loop ends where every
other unbounded thing in this shell ends.

Absent by design: `-u`, cookies, `-F`, `--data-binary`, `-w`, `-k`, and
compression flags. This is a profile, not a reimplementation, and every one of
those is either the host's decision or a shape this environment does not have.

### Virtual devices

`/dev/null`, `/dev/stdin`, `/dev/stdout`, and `/dev/stderr` exist during a
shell execution, along with the `/dev/fd/0`, `/dev/fd/1`, and `/dev/fd/2`
spellings of the last three, under a `/dev` that reads as a directory holding
exactly them.

The whole of `/dev` is reserved. Reads and writes are answered; every
namespace change is refused, so `mkdir /dev`, `rm /dev/null`, `touch
/dev/null`, and `cp /dev/null f` are errors. That single rule is what keeps
the device view and the entry view from disagreeing — without it a real
`/dev/null` would be read as the device but listed, moved, and removed as a
file, and a write to it would be silently discarded.

`ls /` shows `dev`, and `find / -maxdepth 1` reports `/dev`, because those ask
the same question and a directory you can enter, stat, and read has to be one
you can see. A recursive walk of the root reports `/dev` itself but does not
descend into it: what is inside are descriptor paths a recursive reader cannot
open, so `grep -r /` would collect errors instead of results. Naming `/dev`
directly still lists everything in it.

### The applet directories

`/bin` and `/usr/bin` are reserved the same way. They resolve commands without
namespace rows — that is what makes `/bin/cat` run whether or not PATH lookup
is enabled — and they are listable, so `which cat` answering `/bin/cat` and
`ls /bin` showing it are the same fact rather than two that disagree.

They hold no rows, which is the point: a row could be removed while `/bin/cat`
kept working. Reservation gives the same guarantee without the invisibility —
`rm -r /bin`, `mkdir /bin/x`, and `touch /usr/bin/y` are refused.

An applet path reports as a regular file with mode `755` and size zero, so
`test -x /bin/cat` is true and `test -f` is too. Reading one is refused: there
is no file behind it, and answering with nothing would read as an empty file.

Only names that resolve as a path are listed. A session built-in such as `cd`
has no program form, so it is absent rather than advertised as a `/bin/cd`
that would exit 127. `.` is a real applet whose path spelling collapses onto
the directory itself, so it cannot be an entry in it.

`/dev/null` discards what is written to it and reads as empty. Nothing is
buffered and nothing extra is charged: the bytes were already metered when
whatever produced them ran, so `cmd > /dev/null` costs exactly what
`cmd > file` costs and never exhausts a budget sooner.

The other three are aliases for this execution's descriptors, taken through
the same reference counting `2>&1` uses. An alias can release its own
reference but never destroy what it duplicates, so a later redirection that
fails does not discard output already written. An alias names where the
descriptor points at the moment it is opened, which is why
`> /dev/null > /dev/stdout` discards, as it does in Bash. They are redirection
sources and targets only — as a command operand a descriptor path is a usage
error, because there is no file behind a descriptor for one to name. A link
to a device is followed like any other link, so `ln -s /dev/null quiet` makes
`> quiet` discard.

They report as character devices: `test -e`, `-r`, `-w`, and `-c` succeed,
`test -f` fails because a device is not a regular file, and `stat`, `file`,
and `ls -l` say so. Any other `/dev` path is `ENOENT`; `/dev/zero`, terminals,
and the rest would each need a model this runtime cannot make true.

The declared roots do not govern devices, and that is deliberate rather than
an oversight. A device names nothing in the namespace: `/dev/null` discards,
and the descriptor paths duplicate streams the caller already handed this
execution. Requiring `/dev` in a session's roots would break `> /dev/null` for
every scoped caller while preventing nothing. Everything the roots do name is
still governed, including a path that tries to leave through `/dev/..`.

### Symbolic links

`ln -s` creates a link and stores the target exactly as written. The target is
not resolved, not checked, and not required to exist: a dangling link is a valid
link, and refusing to create one would make the order a tree is restored in
significant. `ln` without `-s` is a usage error — a hard link is two names for
one entry, and a path is unique here. Entries do carry an identity, and it does
not change that: the obstacle is the shape of the namespace, not the absence of
an inode number.

Which commands follow a link and which act on it is the POSIX split, and it is
the part worth reading twice. `cat`, `test -f`, `chmod`, and a redirection
follow it, so writing through a link writes the target and leaves the link
alone. `rm`, `mv`, `mkdir`, and `ln -sf` act on the link itself, so removing a
link to a directory leaves the directory, and a dangling or cyclic link can
still be removed and renamed — it is the link being named, not what it fails
to reach. `stat`, `ls -l`, `ls -d`, `file`, `du`,
`find`, and `test -L` report the link, with `stat -L` following instead. `ls`
without `-l` or `-d` lists through a link to a directory, as `ls` does. `cp`
follows a named link but `cp -r` and `cp -P` copy the link itself, because a
subtree with every link expanded is a different subtree.

`readlink` prints the stored target and exits 1 without output when the path is
not a link, which is what makes it usable in a conditional. `readlink -f` and
`realpath` print the canonical path with every link on the way resolved.

A link may name anything, including a path outside the shell's roots. The
refusal happens when it is followed rather than when it is made: every read and
write resolves the path first and checks the roots against what it resolved to,
so `EACCES` is reported at the moment of access with ordinary utility status 1.
Shell-policy refusal remains status 126. `lstat` and `readlink` are
checked against where the link lives instead, because they answer questions
about the link and not about its target.

A pattern expands through a link when the link is named literally, so
`echo /link/*` and `cd /link; echo *` both work. A wildcard that would have to
match the link's own name does not expand through it; that is declared, as is
the rule that `..` is collapsed before any link is followed.

`ln -s` names an existing directory as its destination the way `mv` and `cp`
do, linking inside it. `cp -p` preserves the metadata of whatever it copied —
the target when it followed the link, the link when it did not — and never
restates a copied link, whose mode is fixed and whose `setMetadata` would
follow.

Resolution is bounded at forty hops. Past that the path is refused with
`ELOOP`, whether it is a cycle or merely a long chain — the two cannot be told
apart without a bound, and a constant makes the refusal deterministic.

### Recursive and batched actions

`grep -r` walks a subtree through the paged traversal, so a large directory
costs a bounded number of indexed queries and charges the shared glob budget;
`ls -R` lists one directory at a time as it descends. Both report each path the
way the operand was written, as GNU does, so `grep -r x t` prints `t/sub/file`.
A file `grep -r` cannot open is reported on stderr and the walk continues, so
one unreadable entry does not discard the matches already found; the status is
then 2 rather than 0 or 1. With `-r` the filename is prefixed only when more
than one file can be searched, so `grep -r x one.txt` prints bare lines.

`find -print0` separates with NUL so a path containing a newline survives the
hand-off to `xargs -0`. `find -exec` dispatches an already-expanded argv through
the same registry, policy, and budget as any other command, so a matched path
can never become shell syntax; `;` runs once per match and `+` batches up to 256
paths per invocation. Every `{}` in a word is substituted, not only a word that
is exactly `{}`, so `-exec mv {} {}.bak ';'` renames rather than writing to a
file called `{}.bak`. A failing invocation does not stop the walk; as POSIX has
it, only the `+` form reports it in `find`'s own status.

### The jq profile

`jq` runs a declared subset of the filter language, and refuses the rest where
it is written — status 3, before any input is read. That is the same stance the
`sed` profile and the regular-expression subset take, and it is what lets a
filter this accepts mean here what it means in `jq`.

It is the only language in this shell with an oracle. `jq` is deterministic and
containerized, so the profile is held to answers recorded from
`ghcr.io/jqlang/jq:1.7.1` rather than to an argument about what it ought to
print.

**In the profile.** Paths — `.a`, `.a.b`, `.["k"]`, `.[0]`, `.[-1]`, `.[]`,
`.a[]`, `.[1:3]`, and a trailing `?`. Composition — `|`, `,`, and `//`.
Comparison, `and`/`or`, arithmetic on the types `jq` allows it on, and array and
object construction including `{a}` shorthand and a computed `(expr):` key.
Builtins: `add`, `all`, `any`, `empty`, `first`, `flatten`, `from_entries`,
`has`, `join`, `keys`, `keys_unsorted`, `last`, `length`, `map`, `max`, `min`,
`not`, `range`, `reverse`, `select`, `sort`, `sort_by`, `split`, `to_entries`,
`tonumber`, `tostring`, `type`, `unique`, `values`. Options: `-c`, `-e`, `-j`,
`-n`, `-r`, `-s`, `-S`, `--tab`, `--arg`, `--argjson`.

**Refused.** `def`, `reduce`, `foreach`, `try`/`catch`, `label`, `as` bindings,
recursive descent `..`, string interpolation, format strings such as
`@base64`, and the regular-expression builtins. The last is deliberate rather
than pending: `jq` matches with Oniguruma and this repository has a POSIX
engine, so `test("a+")` would mean two different things under one name.

Two things a JavaScript object cannot do shape the value model. An object
reorders integer-like keys — `{"2":1,"1":2}` parses with `1` first — so members
are held in insertion order and print the way they arrived. And `JSON.parse`
discards how a number was written, so a parsed number carries its own spelling:
`1.0`, `2.50`, and an integer past a double's reach print back unchanged. A
number written with an exponent is the declared exception.

Statuses follow `jq`: 3 for a filter this profile refuses, 5 for a failure while
running one, 1 under `-e` when the last output was `false` or `null`, and 4
under `-e` when there was no output. A usage error is 2, as everywhere else.

The whole input is read before the first output, so an opaque R2 body is
`ENOTSUP` for the same reason `sort`'s is.

### The sed profile

`sed` implements `s`, `p`, and `d`, each optionally selected by a line number,
`$`, a `/regex/`, or a two-address range, and optionally negated with `!`.
`-n` suppresses the automatic print, `-e` repeats, and the `s` flags are `g`,
`p`, `i`, and an occurrence number, which combine as `2g` does in GNU sed. A
replacement expands `&` and `\1`…`\9` and writes everything else literally.

Hold space, branching, labels, and `a`, `i`, `c`, `y`, `r`, and `w` are outside
the profile and are usage errors: they are a programming language rather than a
utility, and several need state across records that a streaming profile cannot
bound. Every command in the subset reads only the current record, so ordinary
operation streams.

Several details follow GNU exactly because getting them wrong is silent. The
operands are one stream: line numbers run continuously across them and `$` is
the last record of the last file. A range's end address is looked for starting
at the record *after* the one that opened it, so `1,/a/` reaches the second `a`
and `2,1` selects one record. A record the input left unterminated is written
back unterminated. An empty match touching the end of the previous one is not a
second occurrence, so `s/a*/-/g` on `baaac` gives `-b-c-`.

`-i` is the one barrier: it publishes a single guarded whole-file write
protected by the path's mutation token, so a concurrent change loses rather than
interleaves, and there is never a visible temporary file. Each operand is edited
under its own token; one that fails is reported on stderr while the rest are
still edited, and the status is 2.

### Deterministic utilities

`date` always reports UTC, because the runtime fixes `TZ=UTC` and has no
timezone database; `-u` is accepted and changes nothing. The conversions are
`%Y %m %d %H %M %S %F %T %s %%`, and setting the clock is not supported. The
value comes from the execution's injected clock, which on Workers advances only
across I/O — see [the deadline note](operations.md#execution-budgets).

`sleep` takes whole seconds, wakes immediately on cancellation, and refuses a
duration that could not finish inside the execution deadline rather than serving
it until the timeout. `expr` evaluates one infix operation — integer arithmetic,
a comparison, or `length` — and exits 1 when the result is zero or empty. It is
deliberately not a grammar: precedence and grouping belong in `$(( ))`.

General utilities share a deterministic option syntax. Supported short flags
may be clustered (`rm -rf`, `grep -inF`, `wc -lwc`, `comm -123`), and a short
option argument may be attached or separate (`head -n10` or `head -n 10`,
`cut -d:` or `cut -d :`). Required long-option arguments may likewise use
`=` or a separate word. `--` ends option parsing so a later word beginning
with `-` is an operand. An option requiring an argument consumes the remainder
of its cluster before considering the next word. `head` and `tail` also retain
the historical `-10` line-count form.

This syntax does not add options beyond the table. An unsupported member of a
cluster is a usage error naming that member; for example, `ls -als` reports
unsupported `-s` and then prints the `ls` synopsis. `ls -a` and `ls -A` are accepted compatibility no-ops because
directory listings already include stored dot-prefixed names and never
synthesize `.` or `..`. `find` expressions and the `set` and `getopts` built-ins
keep their separately documented grammars.

Text utilities use fatal incremental UTF-8 decoding unless the operation is
explicitly byte-based. Invalid UTF-8 is `EIO`. `cat`, byte `head`/`tail`, byte
`wc`, and `cmp` preserve arbitrary bytes. When both `-n` and `-c` are supplied
to `head` or `tail`, the last mode option completely determines the mode and
count. Line length and record count are bounded independently from byte count.
Commands batch small output into roughly 64 KiB
slabs. `sort`, `tail`, `paste`, `diff`, `comm`, `join`, `patch`, hashing, and
atomic VFS commits buffer only at their semantic barriers.

`seq` operands are strict decimal integers, so a leading `-` before digits is
an operand rather than an option cluster. Bash arithmetic expressions, floating
point, and format strings are outside the profile. `-s` joins values and the
sequence still ends with exactly one newline, so the default separator yields
one record per value and an empty range prints nothing. `base64` uses the
standard alphabet; decoding rejects invalid input instead of guessing. `-w 0`
disables wrapping entirely, including the trailing newline. `env` prints only
names matching `[A-Za-z_][A-Za-z0-9_]*` in UTF-8 byte order, so positional
parameters such as `0` are absent; `-i`, `-u`, `-0`, and the bare `-` form are
outside the profile.

`command -v NAME` prints a spelling a script can run: the applet path when a
search found one, and the bare name for a function, a built-in, or an applet
resolved without a search. It exits 1 when the name is unknown, and accepts one
name. `command NAME [ARGUMENT...]` runs the applet even when a function shadows
it; option scanning stops at that name, so the invoked utility keeps its own
options. Bash's `-V` and `-p` forms are outside the profile. `type` classifies each name and reports an
unknown one on stderr with status 1; it does not print a function body. `which`
reports only names with a program form, so a function and a shell built-in such
as `cd` are not found, and it needs a `PATH` to have a path to print.
`printenv` prints the whole environment in UTF-8 byte order, or one value per
named variable, exiting 1 when any is unset; the `-0` form is outside the
profile.

`xargs` reads standard input as data, never as source. Arguments split on the
fixed whitespace profile, or on NUL under `-0`, and reach the command registry
already expanded through `ShellCommandContext.executeCommand()`, so input can
never introduce shell syntax, quoting, or an `eval`. Invocations share the
caller's command, step, mutation, and I/O budgets. A non-zero invocation yields
status 123, an unrunnable or missing command yields 126 or 127, and status 255
aborts the run; a bounded-execution failure raised by an invoked command
propagates rather than being converted to 123. Bash's quote-aware splitting and
the `-I`, `-L`, and `-P` options are outside the profile.

Named utilities implement the documented subset, not every GNU/BSD option.
Unsupported options are usage errors rather than silently ignored behavior.

## Opaque behavior

Opaque files are normal regular files for pathname and metadata operations but
their bodies reach the shell capability object only through an opt-in content
reader; see "Opaque R2 content".

| Operation | Behavior |
| --- | --- |
| `ls`, `stat`, `find`, `tree`, glob, `du`, `test -f`, `file` | metadata only; succeeds |
| `touch`, `chmod`, `mv` | SQLite metadata/namespace only |
| `cp` | creates another metadata reference; no R2 body transfer |
| `rm` | unlinks and durably queues the last unreachable generation |
| `cat`, `head`, `grep`, `wc`, and `<` redirection | stream the body when the host supplies a content reader and the session allows it; otherwise `ENOTSUP` before any R2 read |
| `sort`, `sed`, `cut`, `tr`, `nl`, `fold`, `base64`, `tail`, `uniq`, `paste` | `ENOTSUP`: each holds all of its input |
| `cmp`, `diff`, `patch`, `join`, `comm` | `ENOTSUP` if an opaque body is required |
| `sha256sum` | emits a trusted verified digest; otherwise `ENOTSUP` |
| `>>` and append `tee` | `ENOTSUP` |
| `>` | atomically replaces the entry with bounded inline bytes and queues old R2 content if unreachable |

`readOpaque()` and upload lifecycle methods remain on the programmatic VFS;
they are not present on `ShellCommandContext.fileSystem`.

## Direct VFS primitives

`VirtualFileSystem` operates on bytes and canonical paths:

- `stat`, `list`/`listPage`, `find`/`findPage`, and `countSubtree`, each
  reporting `ino` alongside the rest of an entry's metadata;
- `changesSince`, when the filesystem was built with `recordChanges`;
- `statById`, which reads an entry back by its identity;
- `readFile`, `writeFile`, `writeFiles`, `appendFile`, `touch`,
  `setMetadata`, and `setOwnership`;
- `mkdir`, `remove`, `move`, and `copy`;
- `getMutationToken` and the optional `ifMutationToken` guard;
- `beginOpaqueUpload`, `commitOpaqueUpload`, `abortOpaqueUpload`;
- `resolveOpaqueRead` and `drainGarbage`.

`SqlFileSystem` implementations also satisfy `PosixVirtualFileSystem`.
`forCredentials({ uid, gid, supplementaryGids }, { umask })` returns an
immutable access-controlled `VirtualFileSystem` view. The raw object remains
the trusted administration capability. The bound view disables opaque upload
and GC administration, and refuses `statById`, because identities are
consecutive and reading by one would let any credential enumerate the workspace
by counting; opaque reads still require ordinary read permission and the
separate shell content capability.

Inline `readFile()` returns a stable bounded stream snapshot. Consume or cancel
it to release the instance-wide materialization budget. Writes accept strings,
buffers, typed views, or byte streams and publish once after normal collection.
A string body is snapshotted and published before `writeFile()` returns its
promise, so the completed call is immediately visible just as a POSIX `write`
is when it returns. Byte views, buffers, and streams retain the
collect-then-revalidate path because JavaScript accessors can run while a view
is inspected and a stream necessarily crosses an asynchronous boundary.

`writeFiles(entries, options)` writes several bodies to several paths as one
change. `copy`, `move`, and `remove` are already atomic however many entries
they touch; a caller writing distinct bodies to distinct paths had no
equivalent, and a deadline, a stale guard, or a quota refusal on the seventh of
twelve `writeFile` calls leaves a tree that matches nobody's intent. A failed
batch leaves every path exactly as it was, including the paths earlier in the
array.

Each entry carries its own `path`, `body`, optional `mode`, and optional
`ifMutationToken`; `createParents`, `disposition`, and `skipIfUnchanged` apply
to the call. A set too large for the in-flight budget fails with `ENOSPC` and
has to be split; one that merely collided with concurrent work fails with
`EAGAIN` and can be retried. The per-entry guard is what makes it composable rather than
convenient: a caller replacing a known set of files gets all-or-nothing against
concurrent mutation. Every path reports its own revision and token, a matched
`skipIfUnchanged` entry reports the ones already in force, and naming one path
twice is refused. The credential-bound view offers it, and every per-entry
permission check the single-path form performs still runs.

A batch keeps aggregation cheaper than separate writes: measured on the guard,
`writeFile` and a `writeFiles` of one entry cost 8 and 9 statements respectively,
both writing 3 rows. Three string files cost 21 statements and 7 rows as a batch
against 24 and 9 as three calls.
The batch retains collection and revalidation because entry getters can run
caller code even when their resulting bodies are strings. What can become one
unit is still what a caller can hand over as one intent — this does not make a
shell script atomic, and a script wanting the same guarantee should stage into
a directory and finish with one `mv`, which already is.

`writeFile(path, body, { skipIfUnchanged: true })` publishes nothing when the
body is already exactly what is stored, and reports the revision and token that
are already in force so the caller keeps a usable guard. It is for a caller
that writes a derived snapshot back into the namespace — a document flushed on
a timer, a rendered artifact, a mirrored file — where the cost worth avoiding
is not the write but the revision bump, which invalidates every other holder's
optimistic guard on that path.

Everything a write validates still applies, in the same order: the disposition,
the mutation-token guard, the directory check, and write permission are all
decided before an unchanged body can return, so a stale guard fails exactly as
it would have. A skipped write does not advance `modifiedAtMs` and emits no
usage event, because nothing was committed. Deciding it reads the stored body
once and records an internal digest of it, so later calls decide in a constant
number of rows however large the file is; the digest is stamped with the
revision it was taken at, so any change to the content retires it. Only an inline body is compared —
an opaque entry is always replaced, since deciding otherwise would mean reading
an R2 body inside the namespace transaction — and a `mode` differing from the
current one writes, because the mode is part of what the call asked for.

The comparison is ordered so it can only charge where it can decide something.
A body of a different length is settled from a size column already in hand and
reads nothing; only one of the same length costs a single read of the entry's
own chunks. Measured on the guard: an overwrite is 10 statements with the
option off *and* with it on against a differing length, 11 when a same-length
body has to be compared and then written, and 5 when the write is skipped.
Metadata queries, inline snapshots, `touch`, `setMetadata`, `mkdir`, and opaque
read-lease resolution are synchronous local operations. Stream ingestion, R2
verification, garbage-alarm scheduling, and garbage draining return promises.
Workers RPC still exposes every remote call as a promise; that transport
contract is separate from the local `VirtualFileSystem` contract.

Pagination cursors are keyset positions, not durable snapshots. Continue
through empty filtered pages until `nextCursor` is null. A concurrent mutation
before the cursor can be missed; restart when a fresh complete traversal is
required.

`find()` materializes a `VfsStat` per match and stops at its 10,000 default
limit. When only the size of a subtree matters — charging a budget, deciding
whether a recursive removal is worth confirming — use `countSubtree()`, which
answers with one indexed range query, allocates nothing per entry, and has no
result ceiling. It counts the root itself and raises `ENOENT` for an absent
path.

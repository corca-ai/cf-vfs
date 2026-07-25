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
| false `test`, no `grep` match, `cmp`/`diff` difference | 1 |
| syntax or usage error | 2 |
| command unavailable by policy | 126 |
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
- `<`, `>`, `>>`, `2>`, `2>>`, left-to-right `2>&1`, `<<`, `<<-`, and `<<<`;
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

`-e`, `-f`, and `-d` resolve canonical absolute or `cwd`-relative VFS paths.
An empty or missing path is false. Read-policy denial remains status 126 rather
than being hidden as false. Opaque R2 entries satisfy `-e` and `-f` from their
namespace metadata without reading their bodies. Regex `=~`, single `=`, and
inode, ownership, timestamp-order, device, socket, size, and permission tests
are rejected as unsupported syntax.

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

`test`, `[`, and `[[ ]]` all offer `-e`, `-f`, `-d`, `-s`, `-r`, `-w`, and `-x`. They
read compatibility mode bits and report whether *any* class carries the bit,
because there is no user, group, or account to ask about. They enforce nothing,
and they do not consult the shell's read and write roots: those refuse an
operation, and a predicate that reported them would conflate policy with
metadata. `chmod` accordingly accepts symbolic clauses as well as an octal mode.

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
Filesystem Hierarchy Standard: there is no user database, no package manager, no
writable `/bin`, and no host process.

### Executable scripts

An inline VFS file whose compatibility mode bits include an executable bit runs
as a shell script. `chmod +x script.sh` followed by `./script.sh` behaves the
way it does on Linux, and `sh script.sh` runs a file without requiring the bit.
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
| shell | `:`, `true`, `false`, `echo -n`, `printf` (`%s`, `%d`, `%b`), `pwd`, `cd -`, `export`, `env`, `unset`, `read -r`, `shift`, `getopts`, `source`, `.`, `local`, `return`, `break`, `continue`, `exit`, `set` (clustered `-eu/+eu`, `-o/+o errexit`, `-o/+o nounset`, `-o/+o pipefail`), `test`/`[` (`-e -f -d -s -r -w -x`, string and integer comparison) |
| discovery | `command -v`, `type`, `which`, `printenv`, from the dedicated `/shell/commands/discovery` subpath |
| help | `help -s`, from the dedicated `/shell/commands/help` subpath |
| shell profile | `sh -c`, `sh FILE`, and the `bash` alias, from the dedicated `/shell/commands/sh` subpath |
| namespace | `mkdir -p -m`, `touch -c`, `rm -r -f`, `rmdir`, `mv -f`, `cp -r -f -p`, `ls -l -d -a -A -1 -R`, `find -name -type -maxdepth -print -print0 -exec`, `stat -c`, `chmod`, `du`, `tree`, `basename`, `dirname`, `realpath`, `mktemp`, `file` |
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
their bodies are absent from the shell capability object.

| Operation | Behavior |
| --- | --- |
| `ls`, `stat`, `find`, `tree`, glob, `du`, `test -f`, `file` | metadata only; succeeds |
| `touch`, `chmod`, `mv` | SQLite metadata/namespace only |
| `cp` | creates another metadata reference; no R2 body transfer |
| `rm` | unlinks and durably queues the last unreachable generation |
| `cat`, text `head`/`tail`, `grep`, `sort`, `sed`, `cut`, `tr`, `nl`, `fold`, `base64` | `ENOTSUP` before R2 read |
| `cmp`, `diff`, `patch`, `join`, `comm` | `ENOTSUP` if an opaque body is required |
| `sha256sum` | emits a trusted verified digest; otherwise `ENOTSUP` |
| `>>` and append `tee` | `ENOTSUP` |
| `>` | atomically replaces the entry with bounded inline bytes and queues old R2 content if unreachable |

`readOpaque()` and upload lifecycle methods remain on the programmatic VFS;
they are not present on `ShellCommandContext.fileSystem`.

## Direct VFS primitives

`VirtualFileSystem` operates on bytes and canonical paths:

- `stat`, `list`/`listPage`, `find`/`findPage`, and `countSubtree`;
- `readFile`, `writeFile`, `appendFile`, `touch`, and `setMetadata`;
- `mkdir`, `remove`, `move`, and `copy`;
- `getMutationToken` and optional revision/token guards;
- `beginOpaqueUpload`, `commitOpaqueUpload`, `abortOpaqueUpload`;
- `resolveOpaqueRead` and `drainGarbage`.

Inline `readFile()` returns a stable bounded stream snapshot. Consume or cancel
it to release the instance-wide materialization budget. Writes accept strings,
buffers, typed views, or byte streams and publish once after normal collection.
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

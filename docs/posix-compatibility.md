# POSIX and Bash compatibility

`cf-vfs` borrows familiar pathname, status, utility, and shell behavior where
it maps cleanly to Workers. It is neither a POSIX ABI nor a full Bash
implementation: there are no operating-system processes, syscalls, TTYs, or
host filesystem access.

## Filesystem boundary

| Area | `cf-vfs` behavior |
| --- | --- |
| Paths | `/`-separated canonical Unicode strings with `.`, `..`, repeated-separator, name-length, path-length, and trailing-slash validation. Shell-relative paths resolve from `cwd`. Paths are not arbitrary POSIX byte strings. |
| Regular files | Inline files contain arbitrary bytes and are limited to 8 MiB. Opaque files are immutable R2 generations whose metadata participates in the namespace but whose bodies are unavailable to shell commands. |
| Directories | Direct children, recursive traversal, atomic subtree move, recursive copy/remove, keyset pagination, and deterministic UTF-8 ordering are supported. A paginated traversal is mutation-tolerant, not snapshot-isolated. Listing conservatively requires both read and search permission because the VFS listing primitive returns entry metadata with each name; unlike Linux, a read-only non-searchable directory does not yield names without metadata. |
| Metadata | Kind, content class, byte size, numeric owner and group IDs, mode bits, timestamps, revision, mutation token, and an entry identity in the position `st_ino` holds are available. A link carries its own ownership, revision, token, and identity, separate from its target's. A path's revision only moves forward: whatever lands on an occupied path — a replacing `cp`, `mv`, or `ln -s` — takes one past what was there, so a caller that displays or logs a version never sees it go backwards, and `(identity, revision)` is unique over an identity's lifetime. The identity is stable across a move and across every way of replacing content at a path, including `cp` of one file over another — which keeps the destination's identity as `cp` keeps its inode, since unlinking first is what `--remove-destination` is for. It is never handed out again after a removal — POSIX permits recycling an inode number and this does not, which is a strengthening rather than a divergence. A path answered above the namespace — a shell device, a reserved applet directory — has no entry and reports zero, which every such path shares; `hasEntryIdentity()` is the check, and a caller keying durable state to an identity has to make it or two device paths become one key. There is no `st_dev`, because a Durable Object is the device, and no link-count, access-time, or POSIX change-time guarantees. `statById()` reads an entry back by its identity, reporting the entry itself rather than what it points at; `ENOENT` for one no entry holds is permanent, since an identity is never reissued. It belongs to the trusted capability only and the credential-bound view refuses it with `EPERM`, because identities are consecutive and reading by one would let any credential enumerate the workspace by counting — which is why POSIX declines to open by inode rather than permission-checking it. |
| Modes and identity | The trusted raw VFS is an administration capability and does not enforce DAC. `forCredentials()` and shell executions with host-supplied credentials enforce owner/group/other bits, ancestor search permission, creation/deletion rules, `umask`, setgid-directory inheritance, and sticky directories. IDs are unsigned 32-bit numbers. There is no built-in user/group database; a host may attach a `ShellIdentityResolver` for bulk name presentation and reverse lookup without changing numeric authorization. ACLs, capabilities, and setuid execution are unsupported. |
| Concurrency | Whole-file publication and namespace changes are atomic within one DO. The mutation-token guard rejects stale work, including absent-path ABA and a path repointed at a different entry through a link, because the token composes the workspace epoch with the version of every path crossed and those versions are retained as tombstones while a path is absent. `revision` is an observable and not a precondition: it lives on the entry row, which a removal destroys and which cannot record that a path became a link. |
| Symbolic links | Supported, with the target stored verbatim and a relative one resolved from the link's parent. Resolution follows every component, is bounded at forty hops, and reports `ELOOP` beyond that. `lstat`, `readlink`, `realpath`, and `ln -s` are available; a dangling link is a valid link. |
| Other links and special files | Hard links, devices, sockets, FIFOs, sparse files, xattrs, and `mmap` are unsupported. A hard link is two names for one entry, which this namespace forbids in its shape rather than for want of an identity: a path is unique and an entry stores the one it lives at. `ln` without `-s` is therefore a usage error rather than a copy, and it stays one now that entries carry an identity. |
| Execution | An inline file with an executable mode bit runs as a shell script in an isolated child scope. There are no processes, `fork`, `execve`, signals, job control, or native binaries, and no interpreter other than this shell profile. |
| Locks and open handles | There is no persistent descriptor lifecycle or advisory/mandatory locking. Returned inline streams are bounded snapshots; guards provide optimistic concurrency. |
| Errors | Familiar codes include `ENOENT`, `ENOEXEC`, `EEXIST`, `ENOTDIR`, `EISDIR`, `ENOTEMPTY`, `ELOOP`, `EFBIG`, `ENOSPC`, `EPIPE`, and `ENOTSUP`. `EREVISION` denotes a stale guard, and `EAGAIN` a refusal worth retrying rather than a permanent one. This is not the complete POSIX errno set. |

`/dev/null` and the descriptor paths `/dev/stdin`, `/dev/stdout`, `/dev/stderr`
and their `/dev/fd/N` spellings exist during a shell execution and nowhere
else. They are not namespace entries and cost no storage. The whole of `/dev`
is reserved against change, and the declared roots do not govern devices
because a device can name nothing the roots protect. No other device exists.

Virtual descriptors `0`, `1`, and `2` exist only for one submitted source
unit, including in an interactive session. Pipelines connect them with byte
streams and left-to-right `2>&1` / `>&2` duplication; they are not Durable
Object state
and have no shared seek offset.

## Shell language

Bash Version 4 supports simple commands and assignments; quoting and escapes;
selected parameter, command, and arithmetic expansion; lists and pipelines;
groups, subshells, control structures, functions, and selected flow built-ins;
ordinary redirection, here-documents, here-strings, and pathname expansion. See
[Shell, commands, and direct API](commands.md) for the exact grammar and limits.

The parser rejects unsupported syntax before running any command. In
particular, process substitution, arrays, out-of-profile extended-test
operators, C-style `for`, background jobs, and arbitrary descriptors are not
approximated. The language version is exported as
`BASH_COMPATIBILITY_VERSION`.

Brace expansion runs first among the expansions and reads only the word, so a
brace that arrives through a parameter is text rather than syntax:
`v={a,b}; echo $v` prints the braces. Lists, ranges over integers and code
points, an increment, zero-padded ranges, nesting, and adjacency all follow
Bash — `pre{a,b}post`, `{1..10..3}`, `{01..3}`, `{a..e}`, `{a,{b,c}}`, and
`{a,b}{1,2}`. Braces that spell no group stay literal, which covers `{a}`,
`{}`, and an unmatched `{`, and quoting suppresses expansion whether written
as `"{a,b}"` or `\{a,b\}`. An alternative that contributes nothing
contributes no word, so `{a,}` is one word and `{,}` is none. Assignments and
`case` patterns are single-word positions and are not expanded, matching Bash.
A redirection target that expands to other than one word is an error; the
status differs from Bash and is a declared divergence.

Backtick command substitution runs. The closing backtick is found by scanning
rather than parsing — quoting does not protect one and only `` \` ``, `\\`,
and `\$` escape — so it nests solely through escaping and `$(...)` remains the
spelling to prefer. It is supported because generated scripts contain it, not
because it is the better form.

Version 3 additionally includes `source` and `.`, which read only an explicit
inline VFS path, never search `PATH`, parse the complete sourced unit before
executing it, and share all relevant budgets with the caller. Opaque files
remain unavailable.
`read -r`, `shift`, and short-option `getopts` provide the non-interactive input
and positional primitives used by reusable VFS scripts. `read` has no prompt,
timeout, terminal, or readline behavior; it uses bounded virtual fd 0 and the
fixed whitespace `IFS` profile.
Scalar parameter expansion additionally supports shortest/longest shell-pattern
prefix and suffix removal, first/global pattern replacement, and bounded
Unicode-code-point substrings. Patterns use the declared glob syntax without
pathname or dotfile rules, and quoted fragments remain literal.
Nounset is available through both short and named `set` forms. An evaluated
implicit unset reference terminates its current shell scope with status 1;
functions, sourced units, and groups share the caller scope, while subshells,
pipeline stages, and command substitutions are isolated scopes.
The bounded `[[ ... ]]` profile adds scalar word and string tests, strict
decimal integer comparisons, boolean grouping with short-circuiting, and
metadata-only `-e`/`-f`/`-d` predicates. It performs neither field splitting
nor pathname expansion. Opaque entries participate as regular-file metadata
without exposing R2 content.
Version 4 adds deterministic non-interactive errexit through `set -e`/`+e` and
`set -o`/`+o errexit`. It uses Bash's structural condition, list, pipeline, and
inversion suppression rules, including propagation through invoked compound
commands, functions, sources, and subshells.

Deliberate deterministic choices include:

- `grep` and `sed` patterns are a declared subset of POSIX basic and extended
  regular expressions, translated rather than passed to the JavaScript engine.
  Back-references and the GNU extensions are usage errors, and `-i` folds ASCII
  only;
- `sed` implements `s`, `p`, and `d` with addresses; the rest of the language is
  a usage error. `-i` is one guarded whole-file publication, never a temporary
  file;
- `find -exec` and `xargs` dispatch an already-expanded argv through the command
  registry, so a matched path cannot become shell syntax;

- fixed `LC_ALL=C`, `TZ=UTC`, and whitespace `IFS` defaults, which reassignment
  cannot change because collation and timestamps do not read them;
- tilde expansion covers `~` and `~/path` from `HOME`. `~user`, `~+`, `~-`, and
  `~N` stay literal: there is no user database and no directory stack, so a name
  after the tilde identifies nothing. The substituted value is treated as
  quoted, as in Bash, so a `HOME` holding a glob character cannot turn a
  home-relative path into a wildcard, and it is charged to the expansion budget
  before it is materialized;
- `$-` reports only the options this profile spells as short flags;
- `test -r`, `-w`, and `-x` select the owner, group, or other class when the
  host supplied execution credentials. Without credentials they retain the
  compatibility behavior of asking whether any class carries the bit. These
  predicates do not replace or report the shell's read and write roots;
- UTF-8 byte ordering rather than host locale collation;
- documented utility short options may be clustered, required option arguments
  may be attached or separate, and `--` ends utility option parsing; unsupported
  options are never silently ignored;
- no-match globs remain literal, leading dots must be matched explicitly, and
  `**` has no special cross-directory meaning;
- pipeline stages receive cloned state, while a non-pipeline built-in can
  change the parent session;
- `read -r` preserves a final partial record but returns status 1, and an
  excessive `shift` returns status 1 without changing positional arguments;
- `getopts` exposes `OPTIND` and `OPTARG`, accepts only short options and
  required option arguments, uses leading `:` for silent error results, and
  resets its hidden cluster cursor on an `OPTIND` assignment;
- parameter-pattern matching is locale-independent and work-bounded; substring
  operands are nonempty expanded `-?[0-9]+` decimal integers after trimming,
  negative offsets clamp from the end, and empty operands, leading `+`, and
  negative lengths are rejected. Arrays, indirect expansion,
  extglob, anchored replacement, and Bash's optional `&` replacement behavior
  remain outside the profile;
- `[[ == ]]` and `[[ != ]]` use the same bounded pattern language on an
  unquoted right operand, while lexical comparison uses UTF-8 byte order.
  Integer predicates require strict expanded decimal text instead of Bash
  arithmetic expressions; regex, file ordering, permission, and special-file
  operators remain outside the profile;
- `set -u` does not acquire errexit's condition-sensitive suppression rules:
  `&&`, `||`, `if`, and `!` cannot catch an implicit nounset failure in the
  same scope. This matches the pinned Bash 5.3.3 stdin-script profile; the
  runtime does not reproduce Bash's invocation-mode-specific status quirks;
- errexit is evaluated from AST position rather than command name. Functions,
  groups, and sources share the current option; subshells and pipeline stages
  clone it; command substitution clears inherited errexit like default
  non-POSIX Bash. `pipefail` is resolved before the parent termination decision,
  and normal downstream `EPIPE` remains success;
- subshells and command substitutions also clone session state; command
  substitution output must be bounded valid UTF-8 and contain no NUL;
- arithmetic wraps deterministically at signed 64 bits instead of using the
  platform's native C integer width;
- ordinary groups, function bodies, and expanded unquoted here-documents use
  the current session; quoted delimiters produce literal bodies;
- `set -o pipefail` selects the rightmost real non-zero stage, while normal
  downstream early close maps upstream `EPIPE` to success;
- `xargs` splits input as data on the fixed whitespace profile or on NUL, and
  dispatches already-expanded argv through the command registry. It performs no
  quote, backslash, or `eval` processing, so input cannot introduce shell
  syntax. `seq` operands are strict decimal integers rather than Bash
  arithmetic or floating point, and `env` reports only valid variable names in
  UTF-8 byte order;
- registered applets, except shell built-ins that change the calling session,
  also answer to `/bin/NAME` and `/usr/bin/NAME`. Those are virtual spellings of
  one implementation, not namespace entries: they perform no storage work,
  cannot be created or removed, are not listable, and are not shadowed by a VFS
  file at the same path. The directory match is literal, so `/bin//cat` does not
  resolve. Diagnostics and `allowedCommands` use the canonical applet name, and
  a usage diagnostic ends with the applet's declared synopsis;
- the `PATH` search is opt-in through `commandResolution: "path"`. Without it a
  `PATH` is an ordinary variable and every registered applet answers to its bare
  name, so an application that sets `PATH` for its own reasons cannot lose
  commands. With it, components are searched left to right and only a component
  spelled exactly `/bin` or `/usr/bin` can satisfy one, because executing a
  stored file is not supported yet. A built-in resolves without a search, as in
  Bash, and a prefix assignment applies before the search;
- the opt-in Linux profile is a cf-vfs environment, not the Filesystem Hierarchy
  Standard. It provides `/etc`, `/home`, `/tmp`, `/var/tmp`, and `/workspace` as
  ordinary directories, resolves `/bin` and `/usr/bin` virtually, and adds no
  built-in user database, package manager, writable `/bin`, or host process. A
  host resolver may supply account display names without changing that profile. `/bin/sh`
  and `/bin/bash` name this shell profile and run it, never host Bash;
- an inline file with an executable mode bit runs as a shell script in an
  isolated child scope. A credential-bound execution selects its effective
  owner/group/other execute bit; uid 0 still requires at least one execute bit
  on a regular file. Whatever a shebang names, the only interpreter that can
  exist is this shell profile, so an unsupported one is refused with status
  126 rather than approximated;
- status 2 is syntax/usage, an ordinary utility or DAC failure is 1, 126 is
  shell-policy or executable refusal, and 127 is command-not-found.

Differential fixtures are pinned against `bash:5.3.3` with the same locale and
timezone. They cover representative supported quoting, assignment and
positional expansion, control, pipeline, redirection, glob, and status
behavior. Explicit rejection tests cover syntax deliberately outside Version
4. Neither suite implies compatibility outside the declared subset.

## The one utility with an oracle of its own

`jq` is compared against `ghcr.io/jqlang/jq:1.7.1`, pinned by digest like every
other oracle, in `test/fixtures/jq-compat.json`. Its image carries no shell —
`jq` is the entry point — so a case there is an argument vector and an input
rather than a script, which is why it has its own fixture file and regenerator
instead of sharing the utility one.

Three divergences are declared and demonstrated: a number written with an
exponent is re-rendered from its value, `--arg` and `--argjson` must precede
the filter, and everything outside the declared subset is refused with status 3.
See [the jq profile](commands.md#the-jq-profile).

## The one utility with no oracle

`curl` is compared against nothing. A differential fixture would need a
network, which is the single thing every other fixture is pinned to exclude —
the images run with no egress precisely so that a recorded expectation means
the same thing on every machine and every day.

It is therefore tested against an injected capability that records what it was
asked for, which is also the shape a host implements. What that covers is the
contract: which requests are built, that a redirect re-enters the capability,
that both the capability and the policy are required, and which status each
failure produces. What it cannot cover is any claim about how real curl behaves
against a real server.

That is the reason the command lives behind its own subpath, stays out of
`defaultShellCommands`, and is asserted absent from every bundle preset. A
consumer who does not import it keeps an environment whose behavior is fully
determined by its inputs.

## Utility differential fixtures and declared divergences

Utility behavior is pinned separately against three oracle images recorded by
digest in `test/fixtures/utility-compat.json`: BusyBox, Debian's GNU coreutils,
grep, sed, and diffutils, and Bash for the shell built-ins that command
discovery depends on, all with `LC_ALL=C` and `TZ=UTC`. The exact
tool versions live beside the cases, so a compatibility claim is always tied to
a specific tool rather than to "GNU". These images are development and CI
oracles; no external binary ships or runs at runtime.

Every fixture must succeed with empty output on stderr, and the comparison
asserts stdout, stderr, and status. Diagnostic text is deliberately outside the
profile, so a case that produced a diagnostic could not prove anything: the
generator refuses it. Behavior that intentionally differs is recorded instead in
the `divergences` registry in the same file, and each entry must have a
declarative test demonstrating what `cf-vfs` does. A passing fixture set
therefore never implies an unsupported superset.

Currently declared divergences:

| Command | Divergence |
| --- | --- |
| `cut` | `-f` and `-c` accept a comma-separated list of positive integers. A range such as `-c2-4` is a usage error with status 2 rather than an approximation. |
| `wc` | Multi-field output is single-space separated. GNU right-aligns each count in a width derived from the largest input, which the streaming profile never buffers. Single-field forms such as `wc -l` match exactly. |
| `diff` | Output is always the unified format `patch` consumes; the normal, context, and `ed` formats are outside the profile. |
| `grep`, `sed` | Patterns use JavaScript regular-expression syntax under the Unicode flag, not POSIX basic or extended regular expressions. Literals, `.`, `*`, `^`, `$`, and bracket expressions agree with both and are pinned by fixtures; every other metacharacter differs. `a+` repeats here and is a literal plus under POSIX, while `a\|x` alternates under POSIX and is a literal here. |
| script execution | An executable file runs only as the cf-vfs shell profile, whatever its shebang names. There is no process runtime to hand a file to, so an unsupported interpreter — including an interpreter argument such as `#!/bin/sh -e` — is status 126 rather than something the file did not ask for. |
| `test` | Without execution credentials, `-r`, `-w`, and `-x` report whether any class carries the bit so existing compatibility fixtures remain deterministic. With credentials they use the selected owner/group/other class. They do not consult the shell's read and write roots, and `test -x /bin/cat` is false even though `/bin/cat` runs: an applet path has no namespace entry. |
| `$-` | Lists only `e` and `u`. Bash also reports flags for hashing, brace expansion, and invocation mode, none of which exist here. |
| `cd` | `cd -` with no `OLDPWD`, a bare `cd` with no `HOME`, and an empty operand are usage errors with status 2 rather than Bash's 1. A missing or non-directory target is status 1, as in Bash. `OLDPWD` comes from the working directory the shell tracks, not from `$PWD`, so a reassigned `PWD` cannot desynchronize `cd -`. |
| `type` | Reports that a name is a function without printing its definition. Bash re-renders the parsed body, which would make the output depend on the formatter rather than on the profile. |
| `sed` | The replacement is literal text. GNU expands `&` to the match and `\1` to a capture group; both are written literally here, and JavaScript's `$&`, ``$` ``, `$'`, and `$n` forms are escaped so replacement text taken from data can never splice another part of the record into the output. |

Regenerate with `npm run test:utility-fixtures:regenerate` and review the diff;
Docker is required only for regeneration.

## Atomic redirection divergence

POSIX shells normally open and truncate `>` targets before the command runs.
`cf-vfs` buffers redirected output within the execution budget and publishes
the complete inline file only when that descriptor closes successfully. A
parse failure, later redirection-open failure, cancellation, deadline, output
overflow, or unexpected runtime failure leaves the old target intact. A
normally completed command can still commit output when its status is nonzero.
The same normal-close rule applies when that status triggers errexit; descriptor
settlement precedes the termination decision.

This divergence is intentional: it prevents a bounded cloud execution from
leaving a misleading truncated or partial file. Append redirection similarly
publishes one bounded append at close. Opaque append is unsupported; `>` may
replace an opaque entry with inline bytes and durably queue the old generation.

## Utility names

Utilities implement the options documented by this project, not an implicit
GNU, BSD, or POSIX superset. Unknown options are usage errors. Text-oriented
operations use fatal UTF-8 decoding; byte-oriented operations preserve bytes.
Applications should test against the exported command contract rather than
assuming behavior from a same-named host binary.

# Development

## Repository layout

```text
src/core/             path, glob, error, diff, and patch primitives
src/vfs/              byte VFS contract, SQL core/adapters, streams, opaque lifecycle
src/shell/            parser, expansion, FDs, pipes, redirection, policy, budgets
src/shell/commands/   argv-based built-ins and utilities
src/storage/          Cloudflare R2 and SQL compatibility entry points
src/testing/          Node in-memory SQLite and deterministic R2 adapters
test/                 Node SQLite, workerd, package, docs, and bundle checks
bench/                executable scenarios and checked-in local baseline
scripts/              fixture regeneration
docs/                 documentation, starting at index.md
```

Read [the architecture](architecture.md), compatibility profile, and this page
before changing a public contract.

## Install and verify

```sh
npm ci
npm run check
```

The complete check generates binding types, builds ESM and declarations,
typechecks, lints and formats with Biome, runs Knip for unreachable code and
dependency drift, runs Node SQLite/workerd tests, verifies docs and the
`CLAUDE.md` symlink, installs and typechecks the packed tarball in a temporary
consumer, and checks the Wrangler tree-shaking fixtures. Performance benchmarks
use the separate commands below.

Useful focused commands:

```sh
npm run build
npm run typecheck
npm run lint
npm run lint:fix
npm run format
npm run knip
npm test
npm run test:docs
npm run test:package
npm run test:tree-shaking
npm run bench
npm run bench:do
npm run bench:all
npm run bench:check
npm run bench:remote
npm run bench:remote:check
npm run test:bash-fixtures:regenerate
npm run test:utility-fixtures:regenerate
npm run test:bundle-budgets:record
```

Performance runs are deliberately separate from `npm test` and `npm run
check`. `bench:do` runs the workerd/SQLite operation benchmarks, while
`bench:check` also validates the Node in-memory SQLite scenarios and their broad
regression ceilings. The Performance workflow runs that check weekly and can
also be started manually. The remote commands exercise the separately deployed,
token-protected benchmark Worker at `vfs.borca.ai`; see
[the deployed benchmark notes](performance.md#deployed-benchmark) before
deploying or rotating its secret.

`biome.jsonc` turns off two recommended rules deliberately.
`noTemplateCurlyInString` fires on the `${...}` Bash syntax the parser,
expander, and their tests match as ordinary strings, and `useLiteralKeys`
contradicts `noPropertyAccessFromIndexSignature` in `tsconfig.json`. Test
fixtures are excluded from formatting because they pin exact Bash-observable
strings.

`knip.jsonc` treats every subpath in the package `exports` map as an entry
point, so anything a consumer can import is reachable by definition and only
genuinely dead code is reported. Adding a subpath means adding it to both
files. Unused *type* exports are warnings rather than errors: a library
legitimately publishes types this repository never imports.

## Changing the VFS

Add capabilities to `VirtualFileSystem` in the shared SQL implementation.
Add cases to `test/helpers/vfs-conformance.ts` for common behavior, then
adapter-specific tests for Cloudflare cursor metrics, alarms, RPC, eviction, or
crash recovery. Node tests should cover SQL constraints, quotas, in-flight
accounting, R2 lifecycle, and shell behavior without duplicating VFS semantics.
Never retain a SQL cursor or transaction across `await`.

Schema changes use explicit versioning and constraints/triggers that make
invalid ownership combinations unrepresentable. The pre-deployment `vfs_`
schema uses integer internal identities and currently requires a fresh
filesystem; introducing compatibility migrations is a separate product
decision.

## Changing the language or runtime

`BASH_COMPATIBILITY_VERSION` is a contract. Preserve fragment quoting and
source offsets in the lexer/parser, parse the complete unit before mutation,
and reject unsupported forms deliberately. Add both local parser/expansion
tests and a pinned Bash differential fixture where Bash defines the intended
behavior.

Sourced units are separate parse units: read them only through the scoped VFS,
parse the whole bounded file before executing that file, and charge cumulative
source bytes and AST nodes to the caller's execution. Never give `source` a
`PATH` lookup or access to opaque bodies.

`read -r` must use the managed shell-input cursor rather than taking a raw
reader and discarding the suffix of a chunk after newline. Wrap every root,
pipeline, here-document, here-string, and input-redirection stream at its shell
fd boundary. Tests must cover several records in one chunk, a UTF-8 code point
split across chunks, partial EOF, cancellation, and line/buffer limits.
The top-level executor owns fd 0 for its lifetime and must cancel any unread
root input on every success, failure, or cancellation exit.

Parameter patterns must go through the bounded matcher in `src/shell/pattern.ts`.
Do not translate untrusted glob syntax to a JavaScript regular expression or
reuse pathname matching rules: parameter matching is scalar, has no dotfile or
separator rule, and must charge every candidate transition to the shared
expansion budget. Preserve quoted word fragments before compiling a pattern,
and charge materialized characters and fields after expansion. Add adversarial
limit tests as well as the ordinary semantic matrix.

Implicit nounset failures use `ShellNounsetError`, not an ordinary command
status. Let the error propagate through functions, sourced units, groups, and
same-scope `&&`/`||` evaluation. Catch it only at a real cloned-shell boundary:
a parenthesized subshell, a multi-stage pipeline stage, command substitution,
or the top-level execution. The boundary reports the diagnostic, preserves
status 1, and settles descriptors. Do not add errexit-style suppression rules
to nounset.

Errexit suppression belongs to the AST evaluation context. Pass it through
groups, functions, sourced units, and isolated scopes; do not infer it from a
command name or inspect parent syntax from a leaf command. Only a completed
pipeline requests errexit, after descriptor settlement and after applying
`pipefail` and `!`. Non-final `&&`/`||` pipelines, loop and if conditions,
non-final pipeline stages, and inverted pipelines receive a suppressed context.
Keep explicit `return`/loop/exit flow distinct, and clear errexit only at the
documented command-substitution clone boundary.
Preserve the result's errexit-eligibility bit through non-subshell compound
commands so a protected final failure is not retriggered at a group, `if`,
`case`, or loop boundary. Reset eligibility at function, source, subshell, and
multi-stage pipeline boundaries, where the returned status is a new command or
pipeline result.

Keep `[[ ... ]]` in its dedicated parser AST. Do not lower it to the `test`
built-in or pre-expand it into argv: quote provenance on the right side of
`==`/`!=` determines which pattern fragments are active, and boolean branches
must expand lazily. New operators require parser-time rejection tests, runtime
budget tests, and a decision about metadata policy, opaque files, ordering, and
invalid operands. Reuse scalar expansion and the bounded pattern matcher; do
not add regular expressions or pathname glob scans inside a conditional.
Keep source byte offsets linear-time: reuse the lexer's sparse UTF-8 byte-offset
checkpoints and preserve parser deadline checks. Re-encoding
`source.slice(0, offset)` per token makes a bounded near-limit script
quadratic. The linear scan is the real protection here: parsing performs no
I/O, so on Workers its deadline checks may observe a frozen `Date.now()` and
never fire. Never let a deadline check stand in for a count-based bound — see
[the deadline note](operations.md#execution-budgets).

Regenerate the fixture only after reviewing the semantic change:

```sh
npm run test:bash-fixtures:regenerate
git diff -- test/fixtures/bash-compat.json
```

The generator uses `bash:5.3.3`, `LC_ALL=C`, and `TZ=UTC`. Docker is required
only for regeneration, not ordinary tests.

Use the test DSL in `test/helpers/bash.ts` for ordinary language behavior. It
creates an isolated Node in-memory SQLite database for each case, accepts a
string or an array of commands, and defaults to status 0 with empty stdout and
stderr:

```ts
bashCases([
  {
    name: "keeps a quoted empty argument",
    script: [`unset X`, `printf '<%s>' "$X"`],
    stdout: "<>",
  },
  {
    name: "publishes a redirected file",
    script: "printf body > /result",
    expectedFiles: { "/result": "body" },
  },
]);
```

Cases can also declare `stdin`, `env`, `args`, initial `files`, expected or
missing files, non-zero `exitCode`, exact `stderr`, or `stderrIncludes`. Use
`createBashHarness()` when a case needs custom commands, limits, policy, raw
byte streams, cancellation, or additional state assertions. Keep one behavior
per declarative case; retain a smaller number of explicit integration tests for
backpressure and interactions among several features.

Pipes and sinks are ownership-sensitive. Test both outputs concurrently,
blocked consumers, cancellation, early close, `EPIPE`, duplicated FDs, and
fatal rollback. New buffering code must charge and release the execution-wide
budget in `finally` paths.

## Adding a utility

A command is a `ShellCommand` taking argv and virtual descriptors. Build it with
`defineApplet` from `src/shell/commands/applet.ts`, which pairs a runner with a
declarative `AppletSpec`: canonical name, optional aliases, operand syntax,
one-line summary, and the option table. Declare the specification as a
module-level constant and pass it to `parseAppletOptions` and `appletUsageError`
so the command name appears exactly once. Put shared category implementations
under `src/shell/commands`; use a dedicated module when consumers should import
one command without pulling siblings. Export the command from `shell/commands`,
and add it to `defaultShellCommands` only when it belongs in the convenience
preset.

`applet.ts` sits with the other shared command primitives — `options.ts`,
`helpers.ts`, `format.ts` — and must never import a concrete applet. `shell.ts`
imports it for `createAppletRegistry`, the multicall resolver: canonical names,
declared aliases, and the virtual `/bin` and `/usr/bin` spellings all resolve to
one object. That is the only direction the dependency may run; nothing under
`commands/` may import the shell core. Keep the bare-name path allocation-free —
the applet-path branch is guarded by a single character comparison — and resolve
before checking `allowedCommands` so a policy decision always names the
canonical applet.

Declare `kind` when the applet is not an ordinary `program`. `builtin` means
Bash resolves it without a `PATH` search but Linux still ships a program, such
as `echo` or `test`. `session-builtin` means it changes or inspects the calling
session and therefore has no program form, so it never answers to `/bin/NAME`.
Getting this wrong is observable under `commandResolution: "path"`: a program is
unreachable with an empty `PATH`, and a built-in is not.

The registry answers about one name or one directory at a time and never walks
`PATH`. Ordering a search across components lives in `shell.ts`, which is the
only layer that can also consult the namespace: after no applet answers, it
tries the same name as an executable VFS file.

## Executable scripts

`src/shell/script.ts` holds the interpreter policy and the byte-prefix shebang
scan; it imports nothing but the error type, so the shell carries it and no
applet does. Read the interpreter line from bytes before decoding — an
interpreter line is ASCII by construction, and a 256-byte cap keeps the scan a
fixed prefix rather than a function of file size.

Every refusal to run a file that exists is `ENOEXEC` or `EACCES`, which both map
to status 126; only an absent path falls through to 127. Keep that split, since
it is the only way a caller can tell "nothing by that name" from "there is, and
it cannot run".

Script execution clones the session through `cloneShellSession`, so the child
inherits the environment, working directory, and options while its variables,
functions, working directory, and `exit` stay inside it. Parse the complete unit
before it can mutate anything, count depth with `maxScriptDepth` rather than
`maxSourceDepth` so a script that sources a file that runs a script is still
bounded, and share every other budget with the caller.

Command discovery lives in `src/shell/commands/discovery.ts` and reads
`ShellCommandContext.resolveCommand()`, which runs exactly the resolution order
execution uses. Add discovery behavior there rather than importing the registry
into an applet, so `type` and `which` can never disagree with what would run.

A summary is a lowercase fragment without a trailing period, and a usage
diagnostic ends with the declared synopsis, so `usage` is rendered rather than
carried. `test/applet.test.ts` enforces that shape, pins the exact contents of
`defaultShellCommands`, and rejects a duplicate name or alias;
`test/check-docs.mjs` requires every registered applet to appear in
[the command reference](commands.md). Metadata and the resolver together added
about 640 bytes to the single-applet `ls` Worker bundle and about 1 KiB to the
shell bundle, most of it the resolver rather than the strings. Record new sizes
with `npm run test:bundle-budgets:record` and justify the change in review.

A utility that invokes another command must use
`ShellCommandContext.executeCommand(argv, fds)`, never a generated source
string. It dispatches an already-expanded argv through the same registry,
allowlist, and budgets, so untrusted data cannot become shell syntax, and it
charges the command budget so a dispatching utility cannot escape it. Reserve
`executeSource` for `source` and `.`, which genuinely parse a file.

Use byte streams incrementally unless the operation has a semantic barrier.
Text operations use the shared fatal incremental decoder and line/record
limits. Perform all filesystem access through the scoped command context so
read/write roots and mutation budgets cannot be bypassed. Unsupported options
must be usage errors.

Update the package and Wrangler fixtures when adding a new subpath.

## What belongs in the core

The core is the VFS and the non-interactive shell — see
[what this library is for](index.md#what-this-library-is-for). Before adding to
it, three questions decide where the code goes:

**Does an agent workload run this?** If only a human at a terminal does, it
belongs behind an entry point of its own and must be asserted absent from the
non-interactive presets. Completion is the worked example: it lives in
`/shell/completion`, and `test/check-tree-shaking.mjs` excludes it from every
preset including the one that imports every applet.

**Does a consumer who does not use it still carry it?** A capability that is
off should cost nothing, not a little. The opaque content reader is the worked
example: the host supplies it, so `shell/opaque` is excluded from all eight
presets, and an inline-only shell carries no R2 code at all.

**Would importing one applet drag in the rest?** Shared parsers, formatters,
and path helpers must not import the commands that use them, and an applet
that pulls a large engine belongs in a module where that cost is visible in a
budget rather than hidden in a neighbour's.

A change that fails one of these is not necessarily wrong — but it needs a
recorded budget move and a sentence in the pull request saying which property
was traded and for what.

## Compatibility, bundle, and performance gates

`test/check-tree-shaking.mjs` builds eight representative Worker bundles — one
applet, a small explicit registry, the SQLite filesystem alone, shell-only,
interactive, the full default registry, the opt-in Linux profile, and the R2
opaque adapter. Each preset
declares the library modules that must and must not be reachable *and* a
recorded byte budget in `test/fixtures/bundle-budgets.json`. Size alone is
insufficient, so the inclusion check reads the emitted source map, whose
`sources` array is exactly the module list esbuild kept: renaming a diagnostic
or rewording a comment cannot weaken it. Every fixture imports through a package
subpath so all eight measure the same compiled output. A bundle far below its
budget fails too, so a stale budget can never quietly stop protecting anything;
record new sizes with `npm run test:bundle-budgets:record` and explain the diff
in review.

`test/fixtures/utility-compat.json` pins utility behavior against BusyBox,
Debian's GNU tools, and Bash by image digest and exact tool version, and carries the
registry of deliberate divergences described in
[the compatibility profile](posix-compatibility.md). Every case must produce
empty stderr on the oracle; the generator refuses one that does not, because
diagnostics are outside the declared profile and a case with them would weaken
rather than prove the claim. Every declared divergence needs a declarative
demonstration in `test/utility-differential.test.ts`, which fails when the two
lists drift apart.

`test/performance-guards.test.ts` asserts counted work rather than elapsed time:
output slab batching, SQL statement and row counts for the common no-opaque
path, set-based traversal, and the fact that resolving a registered applet
touches storage zero times. It uses the `onStatement` observer on
`NodeSqlFileSystem`, which exists for tests only and also sees batched
statements and transaction control, so wrapping a read path in a transaction
cannot hide from a guard. Every upper bound is paired with a lower bound,
because an assertion that only caps counted work is satisfied by a meter that
stopped observing. Adding an optional filesystem feature must not add statements
to those paths; extend the guards rather than relaxing them. A `PATH` search
over real namespace entries is a separate, budgeted concern and does not belong
under the applet-resolution guard.

Cancellation, concurrent shells, R2 byte and range behavior, and memory remain
wall-clock scenarios in `bench/`; there is no structural proxy for JavaScript
allocation.

## Packaging and release

The package is ESM and declares `sideEffects: false`. Root, `/vfs`, `/shell`,
`/shell/interactive`, command, storage, Durable Object, and testing subpaths
are intentional boundaries. Do not re-export the interactive adapter from
`/shell`: non-interactive bundle tests require its session-lifecycle
diagnostics to be absent. Relative compiled imports retain `.js` extensions.
`npm pack` contains `dist`, docs, README, license, and package metadata, not
source build artifacts.

Before release, verify current Cloudflare APIs and limits, update the version,
run `npm ci && npm run check`, inspect `npm pack --dry-run`, and publish with
public access. Do not commit `dist`, `node_modules`, `.wrangler`, coverage, or
generated tarballs.

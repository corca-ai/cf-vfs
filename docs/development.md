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

A command is a `ShellCommand` taking argv and virtual descriptors. Put shared
category implementations under `src/shell/commands`; use a dedicated module
when consumers should import one command without pulling siblings. Export the
command from `shell/commands`, and add it to `defaultShellCommands` only when it
belongs in the convenience preset.

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

Update the package and Wrangler fixtures when adding a new subpath. The
`ls`-only and ordinary command-import fixtures must remain free of unrelated
utilities, parser code, and opaque lifecycle code; the VFS-only fixture must
remain free of all shell code.

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

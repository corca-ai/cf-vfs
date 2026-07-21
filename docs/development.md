# Development

## Repository layout

```text
src/core/             path, glob, error, diff, and patch primitives
src/vfs/              byte VFS contract, memory/SQL backends, streams, opaque lifecycle
src/shell/            parser, expansion, FDs, pipes, redirection, policy, budgets
src/shell/commands/   argv-based built-ins and utilities
src/storage/          Cloudflare R2 and SQL compatibility entry points
src/testing/          deterministic memory adapters
test/                 shared conformance, workerd, package, docs, and bundle checks
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
typechecks, runs memory/workerd tests, verifies docs and the `CLAUDE.md`
symlink, installs and typechecks the packed tarball in a temporary consumer,
checks three Wrangler tree-shaking fixtures, and runs every benchmark scenario.

Useful focused commands:

```sh
npm run build
npm run typecheck
npm test
npm run test:docs
npm run test:package
npm run test:tree-shaking
npm run test:benchmarks
npm run bench
```

## Changing the VFS

Add capabilities to `VirtualFileSystem` only when both memory and Durable
Object implementations can provide the same documented semantics. Add cases
to `test/helpers/vfs-conformance.ts` for common behavior, then backend-specific
tests for SQL constraints, quotas, in-flight accounting, alarms, R2 calls, or
crash recovery. Never retain a SQL cursor or transaction across `await`.

Schema changes use explicit versioning and constraints/triggers that make
invalid ownership combinations unrepresentable. This pre-1.0 `vfs2_` schema
currently requires a fresh filesystem; introducing migration support is a
separate product decision.

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
quadratic.

Regenerate the fixture only after reviewing the semantic change:

```sh
npm run test:bash-fixtures:regenerate
git diff -- test/fixtures/bash-compat.json
```

The generator uses `bash:5.3.3`, `LC_ALL=C`, and `TZ=UTC`. Docker is required
only for regeneration, not ordinary tests.

Use the test DSL in `test/helpers/bash.ts` for ordinary language behavior. It
creates an isolated in-memory VFS for each case, accepts a string or an array
of commands, and defaults to status 0 with empty stdout and stderr:

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
command, storage, Durable Object, and testing subpaths are intentional
boundaries. Relative compiled imports retain `.js` extensions. `npm pack`
contains `dist`, docs, README, license, and package metadata, not source build
artifacts.

Before release, verify current Cloudflare APIs and limits, update the version,
run `npm ci && npm run check`, inspect `npm pack --dry-run`, and publish with
public access. Do not commit `dist`, `node_modules`, `.wrangler`, coverage, or
generated tarballs.

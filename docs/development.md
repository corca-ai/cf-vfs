# Development

## Repository layout

```text
src/core/          platform-independent contracts and executor
src/commands/      one tree-shakable module per command
src/storage/       Durable Object SQL and R2 adapters
src/regex/         optional regex engines
src/testing/       in-memory test adapter
test/              workerd integration and package checks
docs/              documentation, starting at index.md
```

## Install and verify

```sh
npm ci
npm run check
```

`check` performs:

1. Wrangler environment type generation;
2. ESM JavaScript and declaration build;
3. strict TypeScript checking;
4. in-memory and workerd SQLite/R2 tests;
5. documentation-link and `CLAUDE.md` symlink validation;
6. tarball creation and installation into a temporary consumer; and
7. an `ls`-only Wrangler bundle check that rejects leaked search/mutation code.

Important individual commands:

```sh
npm run build
npm test
npm run test:package
npm run test:tree-shaking
```

## Adding a command

Create one file in `src/commands` with a typed `runXxx` function and an
`xxxCommand` definition that validates unknown RPC input. Import shared modules
directly, not through barrels. Export it from `src/commands/index.ts` only for
the convenience aggregate. Add behavior tests and confirm the individual
subpath appears in `dist/commands`.

If a command requires a new filesystem capability, add it to the
platform-independent `VirtualFileSystem` contract and implement it in both the
Durable Object and in-memory adapters.

## Packaging

The package name is `@corca-ai/cf-vfs`. `npm pack` includes only `dist`, docs,
README, license, and package metadata. Relative ESM imports use `.js` extensions
so the output works in standards-compliant ESM loaders as well as Wrangler.

`prepare` builds Git dependencies and tarballs, and `prepublishOnly` runs the
complete check. Publishing to npm is a separate release action and requires the
organization's registry credentials.

Before release, verify current Cloudflare APIs and limits, update the version,
run `npm ci && npm run check`, inspect `npm pack --dry-run`, then publish with
public access. Do not commit `dist`, `node_modules`, `.wrangler`, coverage, or
generated tarballs.

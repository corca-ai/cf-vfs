# Deployed terminal demo

The browser terminal at `https://vfs.borca.ai/` is part of the separately
deployed benchmark Worker, not the npm package.

- `demo/workspace.ts` implements the WebSocket protocol and one SQLite-backed
  `DemoWorkspace` Durable Object per browser workspace ID.
- `demo/public/` contains the static terminal UI.
- `wrangler.benchmark.jsonc` binds the demo assets and Durable Object while
  retaining the existing `VfsBenchmark` Durable Object and `/benchmark`
  endpoint.

The demo directory is outside `src`, outside `tsconfig.build.json`, and outside
the package `files` allowlist. Deploying or changing the demo therefore does
not add code to the published library.

Each open WebSocket owns an in-memory `InteractiveShell`; its cwd, variables,
functions, and options live for that connection. The browser sends a bounded
keepalive while the tab is open. Files live in the Durable Object's SQLite
storage and survive reconnects, Worker isolate eviction, and page reloads.

The shell executes as numeric account `1000:1000`; `demo/identity.ts` is the
host-owned account directory that resolves those IDs as `demo:demo`. Existing
rooms created before credential-bound execution transfer their persisted tree
to that account once, so enabling DAC does not strand shared files.

Local development:

```sh
npm run typegen:benchmark
npx wrangler dev --config wrangler.benchmark.jsonc
```

Production deployment:

```sh
npx wrangler deploy --config wrangler.benchmark.jsonc
```

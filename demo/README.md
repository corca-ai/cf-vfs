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

`demo/document.ts` adds the editing pane: one `DocumentRegistry` per room, a
`CollaborativeFileSystem` the shells run against, and a debounced write-back.
A `sed -i` typed in the terminal lands in an open editor as an edit rather
than overwriting what someone is typing, and a `mv` or `rm` moves or closes
the pane instead of leaving it pointed at a path that no longer names
anything.

The document is a string, not a CRDT. Every change to a room — a keystroke on
a socket, a shell command — runs on one single-threaded Durable Object, so
there is no concurrent application for a CRDT to reconcile. A client that
applied its own edits before the server confirmed them is the one that would
need Yjs, and `CollaborativeDocument` is an interface so that host can supply
it. A version stamp catches a client whose text crossed with someone else'''s,
which is the same shape the filesystem'''s mutation token has one layer down.

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

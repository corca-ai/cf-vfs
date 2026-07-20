# Getting started

## Install

```sh
npm install @corca-ai/cf-vfs
```

The package publishes ESM JavaScript and TypeScript declarations from `dist`.
Direct VFS, shell, command, Durable Object, R2, and testing entry points are
separate so a Worker only bundles what it imports.

## Compose a shell Durable Object

The default registry is convenient but deliberately isolated at
`shell/commands/default`. Production applications can pass any explicit array
of `ShellCommand` values instead.

```ts
import { ShellDurableObject } from "@corca-ai/cf-vfs/durable-object";
import { defaultShellCommands } from "@corca-ai/cf-vfs/shell/commands/default";
import { R2OpaqueStore } from "@corca-ai/cf-vfs/storage/r2";

interface Env {
  WORKSPACES: DurableObjectNamespace<WorkspaceFiles>;
  FILE_BODIES: R2Bucket;
}

export class WorkspaceFiles extends ShellDurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, {
      commands: defaultShellCommands,
      opaqueStore: new R2OpaqueStore(env.FILE_BODIES),
      workspaceId: ctx.id.toString(),
      chunkBytes: 256 * 1024,
    });
  }
}
```

Configuration:

```jsonc
{
  "compatibility_date": "2026-07-19",
  "durable_objects": {
    "bindings": [
      { "name": "WORKSPACES", "class_name": "WorkspaceFiles" }
    ]
  },
  "r2_buckets": [
    { "binding": "FILE_BODIES", "bucket_name": "workspace-file-bodies" }
  ],
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["WorkspaceFiles"] }
  ]
}
```

Run `npx wrangler types` after changing bindings. Route one workspace, tenant,
or repository to one object with `getByName(workspaceId)`; do not place an
entire service in one Durable Object.

## Execute source

`executeText()` is the bounded convenience RPC. It drains stdout and stderr
concurrently and returns decoded strings. Use `executeBytes()` when exact bytes
are required; it does not also allocate decoded copies.

```ts
const workspace = env.WORKSPACES.getByName(workspaceId);
const result = await workspace.executeText({
  script: `find src -name '*.ts' | sort > files.txt; wc -l files.txt`,
  cwd: "/repo",
  args: [],
  env: {},
});
```

Dynamic values belong in positional arguments, not interpolated source:

```ts
await workspace.executeText({
  script: `grep -F "$1" "$2"`,
  args: [userPattern, userPath],
  cwd: "/repo",
});
```

For a remote byte-stream boundary, pass explicit RPC streams and sinks through
`executeTo()`:

```ts
await workspace.executeTo({ script, stdin, stdout, stderr });
```

The richer in-process `Shell.executeStream()` returns separate readable stdout
and stderr streams. Start consuming both before awaiting `completed`, otherwise
backpressure can correctly pause execution.

## Use the direct byte VFS

The root and `/vfs` entry points do not import the parser or utilities.

```ts
import { readAllBytes } from "@corca-ai/cf-vfs/vfs";
import { MemoryFileSystem } from "@corca-ai/cf-vfs/testing";

const fs = new MemoryFileSystem();
await fs.writeFile("/bytes", new Uint8Array([0xff, 0x00, 0x01]));
const body = await readAllBytes(fs.readFile("/bytes").stream, 8 * 1024 * 1024);
```

## Upload a large opaque body

The body must not pass through the metadata Durable Object:

```ts
import { putOpaque } from "@corca-ai/cf-vfs/vfs";
import { R2OpaqueStore } from "@corca-ai/cf-vfs/storage/r2";

const objects = new R2OpaqueStore(env.FILE_BODIES);
const stat = await putOpaque(workspace, objects, "/artifacts/model.bin", body, {
  createParents: true,
  expectedSizeBytes,
  contentType: "application/octet-stream",
});
```

Here `workspace` coordinates only reservation, verified metadata commit, and
cleanup intent. `objects.putIfAbsent()` sends the body directly to R2 with a
conditional create. For untrusted clients, put this body operation in a
trusted upload Worker or use trusted multipart completion. See [Operations and
security](operations.md).

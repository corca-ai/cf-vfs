# cf-vfs

`cf-vfs` is a tree-shakable byte-oriented virtual filesystem and non-interactive
Bash-compatible runtime for Cloudflare Workers. One SQLite-backed Durable
Object owns a strongly consistent pathname namespace. Files up to 8 MiB can be
stored inline and read by shell utilities; large payloads live as immutable R2
objects and are intentionally opaque to the shell.

```ts
import { DurableObject } from "cloudflare:workers";
import { Shell, type RemoteExecuteTextOptions } from "@corca-ai/cf-vfs/shell";
import { defaultShellCommands } from "@corca-ai/cf-vfs/shell/commands/default";
import { DurableObjectFileSystem } from "@corca-ai/cf-vfs/storage/do-sql";
import { R2OpaqueStore } from "@corca-ai/cf-vfs/storage/r2";

interface Env {
  WORKSPACES: DurableObjectNamespace<WorkspaceFiles>;
  FILE_BODIES: R2Bucket;
}

export class WorkspaceFiles extends DurableObject<Env> {
  private readonly fileSystem: DurableObjectFileSystem;
  private readonly shell: Shell;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.fileSystem = new DurableObjectFileSystem(ctx.storage, {
      opaqueStore: new R2OpaqueStore(env.FILE_BODIES),
      workspaceId: ctx.id.toString(),
    });
    this.shell = new Shell({
      fileSystem: this.fileSystem,
      commands: defaultShellCommands,
    });
  }

  executeText(options: RemoteExecuteTextOptions) {
    return this.shell.executeText(options);
  }

  override async alarm() {
    await this.fileSystem.drainGarbage();
  }
}

export async function execute(env: Env, workspaceId: string) {
  const workspace = env.WORKSPACES.getByName(workspaceId);
  return workspace.executeText({
    script: `find src -name '*.ts' | sort > files.txt`,
    cwd: "/workspace",
  });
}
```

`WorkspaceFiles` extends only Cloudflare's required `DurableObject`; the cf-vfs
parts are composed normally. `DurableObjectFileSystem` stores paths and inline
bytes in `ctx.storage` (SQLite), while `R2OpaqueStore` connects the `FILE_BODIES`
R2 binding for opaque-body verification and garbage collection. `WORKSPACES`
routes each workspace to its Durable Object. See [Getting
started](docs/getting-started.md) for the Wrangler bindings, migration, and
direct-to-R2 upload path.

This is an application runtime, not an operating-system shell or POSIX ABI. It
does not launch processes, mount a filesystem, or provide an interactive TTY.
The supported language is an explicit versioned subset, and every parser,
execution, stream, mutation, and storage boundary is bounded.

The pre-1.0 stream-first redesign is intentionally breaking. The old
`{ command, input }` structured executor and text/binary storage split have
been removed.

Read [docs/index.md](docs/index.md) for setup, language and command semantics,
the SQLite/R2 lifecycle, limits, benchmarks, and compatibility details.

## License

MIT

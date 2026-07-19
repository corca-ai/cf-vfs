# Getting started

## Install

Until an npm registry release is published, install directly from GitHub:

```sh
npm install github:corca-ai/cf-vfs
```

The package is prepared for a public registry release under the name
`@corca-ai/cf-vfs`. It publishes ESM JavaScript and TypeScript declaration files
from `dist`; consumers do not compile this repository's TypeScript source.

## Compose a filesystem Durable Object

Import commands through their individual subpaths. Commands omitted from the
array are not exposed over RPC and can be removed by the Worker bundler.

```ts
import type { CommandDefinition } from "@corca-ai/cf-vfs/core";
import { catCommand } from "@corca-ai/cf-vfs/commands/cat";
import { grepCommand } from "@corca-ai/cf-vfs/commands/grep";
import { lsCommand } from "@corca-ai/cf-vfs/commands/ls";
import { sedCommand } from "@corca-ai/cf-vfs/commands/sed";
import { statCommand } from "@corca-ai/cf-vfs/commands/stat";
import { VfsDurableObject } from "@corca-ai/cf-vfs/durable-object";
import { createNativeRegexEngine } from "@corca-ai/cf-vfs/regex/native";
import { R2BinaryStore } from "@corca-ai/cf-vfs/storage/r2";

const commands = [
  catCommand,
  grepCommand,
  lsCommand,
  sedCommand,
  statCommand,
] satisfies readonly CommandDefinition[];

interface Env {
  WORKSPACE_FILES: DurableObjectNamespace<WorkspaceFiles>;
  FILE_BODIES: R2Bucket;
}

export class WorkspaceFiles extends VfsDurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, {
      commands,
      binaryStore: new R2BinaryStore(env.FILE_BODIES),
      regexEngine: createNativeRegexEngine(),
    });
  }
}
```

The native ECMAScript regex engine is suitable only for trusted patterns. See
[Operations and security](operations.md#regular-expressions) before accepting
patterns from users or agents.

## Configure bindings

```jsonc
{
  "compatibility_date": "2026-07-19",
  "durable_objects": {
    "bindings": [
      { "name": "WORKSPACE_FILES", "class_name": "WorkspaceFiles" }
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

Regenerate the consuming Worker's environment types after changing bindings:

```sh
npx wrangler types
```

## Execute a command

Use structured inputs instead of parsing a shell string. This avoids quoting
ambiguity and command injection while retaining familiar text output and exit
codes.

```ts
const files = env.WORKSPACE_FILES.getByName(workspaceId);
const result = await files.execute({
  command: "grep",
  cwd: "/repo",
  input: {
    pattern: "TODO|FIXME",
    paths: ["src"],
    include: "**/*.ts",
    maxResults: 200,
  },
  output: "both",
  maxOutputBytes: 256 * 1024,
});
```

One Durable Object should normally represent one workspace or tenant, not the
entire service. Route deterministically with `getByName(workspaceId)` so
unrelated workspaces scale across separate objects.

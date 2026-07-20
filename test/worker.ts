import { defaultShellCommands } from "../src/shell/commands/default.js";
import { ShellDurableObject } from "../src/shell/durable-object.js";
import { R2OpaqueStore } from "../src/storage/r2.js";

export class TestWorkspaceVfs extends ShellDurableObject<VfsTestEnv> {
  constructor(ctx: DurableObjectState, env: VfsTestEnv) {
    super(ctx, env, {
      commands: defaultShellCommands,
      opaqueStore: new R2OpaqueStore(env.VFS_TEST_BUCKET),
      chunkBytes: 1024,
      maxInlineFileBytes: 8 * 1024 * 1024,
      uploadSettlementGraceMs: 1,
      workspaceId: "test",
    });
  }
}

export default {
  fetch(): Response {
    return Response.json({ ok: true });
  },
} satisfies ExportedHandler<VfsTestEnv>;

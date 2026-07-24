import { defaultShellCommands } from "../src/shell/commands/default.js";
import { ShellDurableObject } from "../src/shell/durable-object.js";
import { InteractiveShell } from "../src/shell/interactive.js";
import type { ExecuteTextResult } from "../src/shell/types.js";
import { R2OpaqueStore } from "../src/storage/r2.js";

export class TestWorkspaceVfs extends ShellDurableObject<VfsTestEnv> {
  private readonly interactiveShell: InteractiveShell;

  constructor(ctx: DurableObjectState, env: VfsTestEnv) {
    super(ctx, env, {
      commands: defaultShellCommands,
      opaqueStore: new R2OpaqueStore(env.VFS_TEST_BUCKET),
      chunkBytes: 1024,
      maxInlineFileBytes: 8 * 1024 * 1024,
      uploadSettlementGraceMs: 1,
      workspaceId: "test",
    });
    this.interactiveShell = new InteractiveShell({
      fileSystem: this.fileSystem,
      commands: defaultShellCommands,
      env: { HOME: "/" },
    });
  }

  executeInteractiveText(script: string): Promise<ExecuteTextResult> {
    return this.interactiveShell.runText({ script });
  }
}

export default {
  fetch(): Response {
    return Response.json({ ok: true });
  },
} satisfies ExportedHandler<VfsTestEnv>;

import { InteractiveShell } from "../src/shell/interactive.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { VfsDurableObject } from "../src/vfs/durable-object.js";
import type { ExecuteTextResult, ShellExecution } from "../src/shell/types.js";

interface ReplEnvironment {
  REPL_VFS: DurableObjectNamespace<ReplWorkspace>;
}

interface ReplResult extends ExecuteTextResult {
  cwd: string;
  isClosed: boolean;
}

export class ReplWorkspace extends VfsDurableObject<ReplEnvironment> {
  private readonly interactiveShell: InteractiveShell;
  private activeExecution: ShellExecution | undefined;

  constructor(ctx: DurableObjectState, env: ReplEnvironment) {
    super(ctx, env, { workspaceId: "local-repl" });
    this.interactiveShell = new InteractiveShell({
      fileSystem: this.fileSystem,
      commands: defaultShellCommands,
      env: { HOME: "/" },
    });
  }

  async executeSource(source: string): Promise<ReplResult> {
    if (typeof source !== "string") throw new TypeError("source must be a string");
    const execution = this.interactiveShell.runStream({ script: source });
    this.activeExecution = execution;
    try {
      const [stdout, stderr, result] = await Promise.all([
        new Response(execution.stdout).text(),
        new Response(execution.stderr).text(),
        execution.completed,
      ]);
      return {
        ...result,
        stdout,
        stderr,
        cwd: this.interactiveShell.cwd,
        isClosed: this.interactiveShell.isClosed,
      };
    } finally {
      this.activeExecution = undefined;
    }
  }

  cancelExecution(): void {
    this.activeExecution?.cancel();
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    const workspace = env.REPL_VFS.getByName("default");
    if (request.method === "POST" && url.pathname === "/execute") {
      return Response.json(await workspace.executeSource(await request.text()));
    }
    if (request.method === "POST" && url.pathname === "/cancel") {
      await workspace.cancelExecution();
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<ReplEnvironment>;

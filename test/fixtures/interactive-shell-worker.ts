import { trueCommand } from "@corca-ai/cf-vfs/shell/commands/core";
import { InteractiveShell } from "@corca-ai/cf-vfs/shell/interactive";
import type { VirtualFileSystem } from "@corca-ai/cf-vfs/vfs";

const shell = new InteractiveShell({
  fileSystem: Object.create(null) as VirtualFileSystem,
  commands: [trueCommand],
});

export default {
  async fetch(): Promise<Response> {
    return Response.json(await shell.runText({ script: "true" }));
  },
} satisfies ExportedHandler;

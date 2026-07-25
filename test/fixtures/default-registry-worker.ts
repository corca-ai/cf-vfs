import { Shell } from "@corca-ai/cf-vfs/shell";
import { defaultShellCommands } from "@corca-ai/cf-vfs/shell/commands/default";
import type { VirtualFileSystem } from "@corca-ai/cf-vfs/vfs";

const shell = new Shell({
  fileSystem: Object.create(null) as VirtualFileSystem,
  commands: defaultShellCommands,
});

export default {
  async fetch(): Promise<Response> {
    return Response.json(await shell.executeText({ script: "true" }));
  },
} satisfies ExportedHandler;

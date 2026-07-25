import { Shell } from "@corca-ai/cf-vfs/shell";
import { trueCommand } from "@corca-ai/cf-vfs/shell/commands/core";
import type { VirtualFileSystem } from "@corca-ai/cf-vfs/vfs";

const shell = new Shell({
  fileSystem: Object.create(null) as VirtualFileSystem,
  commands: [trueCommand],
});

export default {
  async fetch(): Promise<Response> {
    return Response.json(await shell.executeText({ script: "true" }));
  },
} satisfies ExportedHandler;

import { trueCommand } from "../../src/shell/commands/core.js";
import { InteractiveShell } from "../../src/shell/interactive.js";
import type { VirtualFileSystem } from "../../src/vfs/types.js";

const shell = new InteractiveShell({
  fileSystem: Object.create(null) as VirtualFileSystem,
  commands: [trueCommand],
});

export default {
  async fetch(): Promise<Response> {
    return Response.json(await shell.runText({ script: "true" }));
  },
} satisfies ExportedHandler;

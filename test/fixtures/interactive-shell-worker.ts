import { trueCommand } from "../../src/shell/commands/core.js";
import { InteractiveShell } from "../../src/shell/interactive.js";
import { MemoryFileSystem } from "../../src/vfs/memory.js";

const shell = new InteractiveShell({
  fileSystem: new MemoryFileSystem(),
  commands: [trueCommand],
});

export default {
  async fetch(): Promise<Response> {
    return Response.json(await shell.runText({ script: "true" }));
  },
} satisfies ExportedHandler;

import { trueCommand } from "../../src/shell/commands/core.js";
import { Shell } from "../../src/shell/shell.js";
import { MemoryFileSystem } from "../../src/vfs/memory.js";

const shell = new Shell({
  fileSystem: new MemoryFileSystem(),
  commands: [trueCommand],
});

export default {
  async fetch(): Promise<Response> {
    return Response.json(await shell.executeText({ script: "true" }));
  },
} satisfies ExportedHandler;

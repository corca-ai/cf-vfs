import { trueCommand } from "../../src/shell/commands/core.js";
import { Shell } from "../../src/shell/shell.js";
import type { VirtualFileSystem } from "../../src/vfs/types.js";

const shell = new Shell({
  fileSystem: Object.create(null) as VirtualFileSystem,
  commands: [trueCommand],
});

export default {
  async fetch(): Promise<Response> {
    return Response.json(await shell.executeText({ script: "true" }));
  },
} satisfies ExportedHandler;

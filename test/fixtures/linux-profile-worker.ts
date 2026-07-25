import { Shell } from "@corca-ai/cf-vfs/shell";
import { defaultShellCommands } from "@corca-ai/cf-vfs/shell/commands/default";
import { linuxShellEnvironment, provisionLinuxFilesystem } from "@corca-ai/cf-vfs/shell/linux";
import { DurableObjectFileSystem } from "@corca-ai/cf-vfs/storage/do-sql";

export default {
  async fetch(_request: Request, env: { STORAGE: DurableObjectStorage }): Promise<Response> {
    const fileSystem = new DurableObjectFileSystem(env.STORAGE);
    provisionLinuxFilesystem(fileSystem);
    const shell = new Shell({ fileSystem, commands: defaultShellCommands });
    return Response.json(
      await shell.executeText({ script: "command -v grep", env: linuxShellEnvironment() }),
    );
  },
} satisfies ExportedHandler<{ STORAGE: DurableObjectStorage }>;

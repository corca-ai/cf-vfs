import { createFsAdapter } from "@corca-ai/cf-vfs/fs";
import { DurableObjectFileSystem } from "@corca-ai/cf-vfs/storage/do-sql";

export default {
  async fetch(_request: Request, env: { STORAGE: DurableObjectStorage }): Promise<Response> {
    const fileSystem = new DurableObjectFileSystem(env.STORAGE);
    const fs = createFsAdapter(fileSystem);
    return Response.json(await fs.promises.readdir("/", { withFileTypes: true }));
  },
} satisfies ExportedHandler<{ STORAGE: DurableObjectStorage }>;

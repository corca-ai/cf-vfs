import { DurableObjectFileSystem } from "@corca-ai/cf-vfs/storage/do-sql";
import { R2OpaqueStore } from "@corca-ai/cf-vfs/storage/r2";

export default {
  fetch(_request: Request, env: { BUCKET: R2Bucket; STORAGE: DurableObjectStorage }): Response {
    const fileSystem = new DurableObjectFileSystem(env.STORAGE, {
      opaqueStore: new R2OpaqueStore(env.BUCKET),
    });
    return new Response(String(fileSystem.list("/").length));
  },
} satisfies ExportedHandler<{ BUCKET: R2Bucket; STORAGE: DurableObjectStorage }>;

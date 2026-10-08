import { createFsAdapter } from "@corca-ai/cf-vfs/fs";
import { TieredFileContent } from "@corca-ai/cf-vfs/fs/content";
import { FsMetadataCache } from "@corca-ai/cf-vfs/fs/metadata";
import { DurableObjectFileSystem } from "@corca-ai/cf-vfs/storage/do-sql";
import { R2OpaqueStore } from "@corca-ai/cf-vfs/storage/r2";

export default {
  async fetch(
    _request: Request,
    env: { STORAGE: DurableObjectStorage; BUCKET: R2Bucket },
  ): Promise<Response> {
    const store = new R2OpaqueStore(env.BUCKET);
    const metadataCache = new FsMetadataCache();
    const fileSystem = new DurableObjectFileSystem(env.STORAGE, {
      opaqueStore: store,
      onEvent: metadataCache.onEvent,
    });
    const content = new TieredFileContent(fileSystem, store);
    const fs = createFsAdapter(fileSystem, {
      content,
      metadataCache,
      maxReadFileBytes: 16 * 1024 * 1024,
    });
    return new Response(await fs.promises.readFile("/file", "utf8"));
  },
} satisfies ExportedHandler<{ STORAGE: DurableObjectStorage; BUCKET: R2Bucket }>;

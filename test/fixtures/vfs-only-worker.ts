import { DurableObjectFileSystem } from "@corca-ai/cf-vfs/storage/do-sql";
import { MAX_INLINE_FILE_BYTES } from "@corca-ai/cf-vfs/vfs";

// A namespace-only consumer: the SQLite filesystem with no shell, no applet,
// and no R2 adapter.
export default {
  fetch(_request: Request, env: { STORAGE: DurableObjectStorage }): Response {
    const fileSystem = new DurableObjectFileSystem(env.STORAGE);
    return new Response(`${fileSystem.list("/").length}/${MAX_INLINE_FILE_BYTES}`);
  },
} satisfies ExportedHandler<{ STORAGE: DurableObjectStorage }>;

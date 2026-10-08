import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { VfsError } from "../src/core/errors.js";
import { createFsAdapter } from "../src/fs/index.js";
import { FsMetadataCache } from "../src/fs/metadata.js";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { readUtf8 } from "../src/vfs/streams.js";

it("resolves dot components and checks traversed directories in actual DO SQLite", async () => {
  const result = await runInDurableObject(env.VFS_TEST.getByName("path-dots"), async (_, state) => {
    const cache = new FsMetadataCache();
    const vfs = new DurableObjectFileSystem(state.storage, { onEvent: cache.onEvent });
    vfs.mkdir("/dir/sub", true);
    await vfs.writeFile("/dir/file", "target");
    await vfs.writeFile("/file", "lexical");
    vfs.symlink("/link", "dir/sub");
    const fs = createFsAdapter(vfs, { metadataCache: cache }).promises;
    await fs.stat("/file");
    const read = await fs.readFile("/link/../file", "utf8");
    const dot = vfs.lstat("/link/.").kind;
    await fs.writeFile("/link/../file", "changed");
    vfs.mkdir("/private");
    vfs.setMetadata("/private", { mode: 0o700 });
    let denied: string | undefined;
    try {
      vfs.forCredentials({ uid: 1001, gid: 1001 }).stat("/private/../");
    } catch (error) {
      if (!(error instanceof VfsError)) throw error;
      denied = error.code;
    }
    return {
      read,
      dot,
      denied,
      target: await readUtf8(vfs.readFile("/dir/file").stream, 100),
      lexical: await readUtf8(vfs.readFile("/file").stream, 100),
    };
  });
  expect(result).toEqual({
    read: "target",
    dot: "directory",
    denied: "EACCES",
    target: "changed",
    lexical: "lexical",
  });
});

/** Correctness probes for automatic-cache and transparent-tier experiments. */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(process.env.POSIX_LIBRARY || "dist");
const moduleAt = (p) => import(pathToFileURL(path.join(root, p)));
const { NodeSqlFileSystem } = await moduleAt("testing/node.js");
const { FsMetadataCache } = await moduleAt("fs/metadata.js");
const { TieredFileContent } = await moduleAt("fs/content.js");
const { MemoryOpaqueStore } = await moduleAt("testing/opaque-store.js");
const { createFsAdapter } = await moduleAt("fs/index.js");
const outcomes = {};
const errorCode = async (operation) => {
  try {
    await operation();
    return null;
  } catch (e) {
    return e.code || e.name;
  }
};
{
  const vfs = new NodeSqlFileSystem();
  try {
    const cache = new FsMetadataCache();
    await vfs.writeFile("/file", "a");
    cache.list(vfs, "/");
    await vfs.writeFile("/file", "longer");
    outcomes.automaticCache = { expected: 6, actual: cache.stat(vfs, "/file", false).sizeBytes };
  } finally {
    vfs.close();
  }
}
{
  const store = new MemoryOpaqueStore();
  let uploaded = 0;
  const put = store.putIfAbsent.bind(store);
  store.putIfAbsent = async (...args) => {
    const body = args[1];
    uploaded += typeof body === "string" ? body.length : body.byteLength;
    return put(...args);
  };
  const vfs = new NodeSqlFileSystem({ opaqueStore: store });
  try {
    const content = new TieredFileContent(vfs, store, { inlineBytes: 1024 });
    const f = createFsAdapter(vfs, { content, maxReadFileBytes: 16 * 1024 * 1024 }).promises;
    await f.writeFile("/target", new Uint8Array(2048));
    vfs.symlink("/link", "/target");
    outcomes.largeSymlink = await errorCode(() => f.writeFile("/link", new Uint8Array(4096)));
    for (const size of [2048, 1024 * 1024, 9 * 1024 * 1024]) {
      await f.writeFile("/append", new Uint8Array(size));
      const startBytes = uploaded,
        start = performance.now();
      const error = await errorCode(() => f.writeFile("/append", "x", { flag: "a" }));
      outcomes[`append-${size}`] = {
        error,
        ms: performance.now() - start,
        uploadBytes: uploaded - startBytes,
      };
    }
    // An explicit chain guard must remain valid at commit, not only at begin.
    await f.writeFile("/a", "old-a");
    await f.writeFile("/b", "old-b");
    vfs.symlink("/guard", "/a");
    const guard = vfs.getMutationToken("/guard");
    store.putIfAbsent = async (...args) => {
      await vfs.remove("/guard");
      vfs.symlink("/guard", "/b");
      return put(...args);
    };
    outcomes.symlinkGuard = {
      error: await errorCode(() =>
        content.write("/guard", new Uint8Array(4096), { ifMutationToken: guard }),
      ),
      aSize: vfs.stat("/a").sizeBytes,
      bSize: vfs.stat("/b").sizeBytes,
      link: vfs.readlink("/guard"),
    };
  } finally {
    vfs.close();
  }
}
await fs.writeFile(
  process.env.POSIX_OUTPUT || "/tmp/cf-vfs-posix-capabilities.json",
  `${JSON.stringify(outcomes, null, 2)}\n`,
);
console.log(JSON.stringify(outcomes));

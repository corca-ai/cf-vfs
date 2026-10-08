import { pathToFileURL } from "node:url";

const { NodeSqlFileSystem } = await import(pathToFileURL(`${process.argv[2]}/testing/node.js`));
const vfs = new NodeSqlFileSystem();
try {
  vfs.mkdir("/dir");
  let reads = 0;
  const token = vfs.getMutationToken("/dir/b");
  const second = {
    path: "/dir/b",
    body: "b",
    get ifMutationToken() {
      if (++reads === 3) {
        void vfs.remove("/dir", { recursive: true });
        vfs.touch("/dir");
      }
      return token;
    },
  };
  let error = null;
  try {
    await vfs.writeFiles([{ path: "/dir/a", body: "a" }, second]);
  } catch (e) {
    error = e.code;
  }
  console.log(
    JSON.stringify({
      error,
      reads,
      parent: vfs.stat("/dir").kind,
      entries: vfs.find({ path: "/" }).map((s) => s.path),
    }),
  );
} finally {
  vfs.close();
}

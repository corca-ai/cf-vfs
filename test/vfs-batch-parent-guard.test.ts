import { expect, it } from "vitest";
import { createTestFileSystem } from "./helpers/node-sql.js";

it("rechecks batch parents after a guard accessor changes the namespace", async () => {
  const vfs = createTestFileSystem();
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
  await expect(vfs.writeFiles([{ path: "/dir/a", body: "a" }, second])).rejects.toMatchObject({
    code: "ENOTDIR",
  });
  expect(vfs.stat("/dir").kind).toBe("directory");
  expect(vfs.list("/dir")).toHaveLength(0);
});

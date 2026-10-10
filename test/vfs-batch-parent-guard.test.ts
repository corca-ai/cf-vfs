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

it("rechecks parent permissions after a nested mutation during batch publication", async () => {
  const vfs = createTestFileSystem();
  vfs.mkdir("/dir");
  vfs.setOwnership("/dir", { uid: 1000, gid: 1000 });
  const user = vfs.forCredentials({ uid: 1000, gid: 1000 });
  let reads = 0;
  const token = vfs.getMutationToken("/dir/b");
  const second = {
    path: "/dir/b",
    body: "b",
    get ifMutationToken() {
      if (++reads === 3) vfs.setMetadata("/dir", { mode: 0o40500 });
      return token;
    },
  };
  await expect(user.writeFiles([{ path: "/dir/a", body: "a" }, second])).rejects.toMatchObject({
    code: "EACCES",
  });
  expect(vfs.stat("/dir").mode).toBe(0o40755);
  expect(vfs.list("/dir")).toHaveLength(0);
  await user.writeFiles([
    { path: "/dir/c", body: "c" },
    { path: "/dir/d", body: "d" },
  ]);
  expect(vfs.list("/dir").map((entry) => entry.name)).toEqual(["c", "d"]);
});

it("consumes a tombstone created by a nested quota callback before publishing a new file", async () => {
  let inject = false;
  const vfs = createTestFileSystem({
    maxEntries: () => {
      if (inject) {
        inject = false;
        void vfs.writeFile("/reused", "intermediate");
        void vfs.remove("/reused");
      }
      return 100;
    },
  });
  inject = true;
  const written = await vfs.writeFile("/reused", Uint8Array.of(7));
  expect(written.mutationToken).toMatch(/:3$/u);
  expect(vfs.getMutationToken("/reused")).toBe(written.mutationToken);
});

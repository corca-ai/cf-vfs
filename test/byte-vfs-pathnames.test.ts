import { expect, it } from "vitest";
import { MemoryOpaqueStore } from "../src/testing/opaque-store.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

it.each(["write", "touch", "symlink"])(
  "refuses a missing directory assertion during %s",
  async (operation) => {
    const fs = createTestFileSystem();
    const create = async () => {
      if (operation === "write") await fs.writeFile("/missing/", "data");
      else if (operation === "touch") fs.touch("/missing/");
      else fs.symlink("/missing/", "/target");
    };
    await expect(create()).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => fs.lstat("/missing")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
  },
);

it("refuses a missing directory assertion for an opaque reservation", async () => {
  const fs = createTestFileSystem({ opaqueStore: new MemoryOpaqueStore() });
  await expect(fs.beginOpaqueUpload("/missing/")).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["copy", "move"])(
  "refuses copying a file to a missing directory assertion with %s",
  async (operation) => {
    const fs = createTestFileSystem();
    await fs.writeFile("/source", "data");
    await expect(
      operation === "copy" ? fs.copy("/source", "/missing/") : fs.move("/source", "/missing/"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => fs.lstat("/missing")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
    expect(fs.stat("/source").sizeBytes).toBe(4);
  },
);

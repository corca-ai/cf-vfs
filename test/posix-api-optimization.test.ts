import { expect, it } from "vitest";
import { createTestFileSystem } from "./helpers/node-sql.js";

it("appends binary bytes without text conversion and crosses chunk boundaries", async () => {
  for (const chunkBytes of [8, 256 * 1024]) {
    const fs = createTestFileSystem({ chunkBytes });
    const initial = new Uint8Array([0, 255, 192, 128, 254]);
    await fs.writeFile("/binary", initial);
    const expected = [...initial];
    for (let index = 0; index < 35; index++) {
      const suffix = new Uint8Array([index, 0, 255, 128]);
      await fs.appendFile("/binary", suffix);
      expected.push(...suffix);
      expect(
        new Uint8Array(await new Response(fs.readFile("/binary").stream).arrayBuffer()),
      ).toEqual(new Uint8Array(expected));
    }
  }
});

it("keeps directory nlink correct for creation, empty removal and mixed subtree changes", async () => {
  const fs = createTestFileSystem();
  fs.mkdir("/tree");
  await fs.writeFiles(
    Array.from({ length: 50 }, (_, index) => ({
      path: `/tree/d${index}/nested/file`,
      body: "x",
    })),
    { createParents: true },
  );
  expect(fs.stat("/tree").nlink).toBe(52);
  expect(fs.stat("/tree/d30").nlink).toBe(3);
  for (let index = 0; index < 25; index++) {
    await fs.remove(`/tree/d${index}/nested/file`);
    await fs.remove(`/tree/d${index}/nested`);
    await fs.remove(`/tree/d${index}`);
  }
  expect(fs.stat("/tree").nlink).toBe(27);
  fs.mkdir("/other");
  await fs.move("/tree/d25", "/other/moved");
  expect(fs.stat("/tree").nlink).toBe(26);
  expect(fs.stat("/other").nlink).toBe(3);
  await fs.copy("/other/moved", "/tree/copied", { recursive: true });
  expect(fs.stat("/tree").nlink).toBe(27);
  await fs.remove("/tree/copied", { recursive: true });
  expect(fs.stat("/tree").nlink).toBe(26);
});

it("discards directory count deltas when a batch creating many parents rolls back", async () => {
  const fs = createTestFileSystem({ maxEntries: 8 });
  fs.mkdir("/tree");
  await expect(
    fs.writeFiles(
      Array.from({ length: 6 }, (_, index) => ({
        path: `/tree/d${index}/nested/file`,
        body: "x",
      })),
      { createParents: true },
    ),
  ).rejects.toMatchObject({ code: "ENOSPC" });
  expect(fs.stat("/tree").nlink).toBe(2);
  fs.mkdir("/tree/after");
  expect(fs.stat("/tree").nlink).toBe(3);
});

it("enforces deep traversal permissions for owners, supplementary groups and root", async () => {
  const root = createTestFileSystem();
  const parent = "/a/b/c/d/e/f/g";
  root.mkdir(parent, true);
  await root.writeFile(`${parent}/file`, "x");
  root.setOwnership("/a/b/c", { uid: 55, gid: 77 });
  root.setMetadata("/a/b/c", { mode: 0o040710 });
  const member = root.forCredentials({ uid: 88, gid: 88, supplementaryGids: [77] });
  expect(member.stat(`${parent}/file`).sizeBytes).toBe(1);
  expect(await new Response(member.readFile(`${parent}/file`).stream).text()).toBe("x");
  const owner = root.forCredentials({ uid: 55, gid: 55 });
  expect(await new Response(owner.readFile(`${parent}/file`).stream).text()).toBe("x");
  expect(() => root.forCredentials({ uid: 88, gid: 88 }).stat(`${parent}/file`)).toThrow(
    expect.objectContaining({ code: "EACCES" }),
  );
  root.setMetadata("/a/b/c", { mode: 0 });
  expect(root.forCredentials({ uid: 0, gid: 0 }).stat(`${parent}/file`).sizeBytes).toBe(1);
  expect(
    await new Response(
      root.forCredentials({ uid: 0, gid: 0 }).readFile(`${parent}/file`).stream,
    ).text(),
  ).toBe("x");
  expect(() => member.readFile(`${parent}/file`)).toThrow(
    expect.objectContaining({ code: "EACCES" }),
  );
  expect(() => owner.readFile(`${parent}/file`)).toThrow(
    expect.objectContaining({ code: "EACCES" }),
  );
  expect(() => member.stat(`${parent}/file`)).toThrow(expect.objectContaining({ code: "EACCES" }));
});

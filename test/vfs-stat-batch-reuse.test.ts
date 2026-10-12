import { expect, it } from "vitest";
import { createTestFileSystem } from "./helpers/node-sql.js";

it("reuses one batch projection without granting the stat caller permission to read", async () => {
  let statements = 0;
  const fs = createTestFileSystem({ onStatement: () => statements++ });
  await fs.writeFile("/private", "secret", { mode: 0o100600 });
  await fs.writeFile("/public", "body");
  const user = fs.forCredentials({ uid: 1000, gid: 1000 });
  user.statMany?.(["/private", "/public"]);
  expect(() => user.readFile("/private")).toThrow(expect.objectContaining({ code: "EACCES" }));
  statements = 0;
  await user.readFile("/public", { range: { offset: Number.MAX_SAFE_INTEGER } }).stream.cancel();
  expect(statements).toBe(0);
  // A snapshot is consumed, not retained indefinitely.
  await user.readFile("/public", { range: { offset: Number.MAX_SAFE_INTEGER } }).stream.cancel();
  expect(statements).toBe(1);
});

it("discards batch snapshots after replacement, deletion, ownership and directory permission changes", async () => {
  const fs = createTestFileSystem();
  await fs.writeFile("/a/file", "old", { createParents: true });
  await fs.writeFile("/other", "other");
  const user = fs.forCredentials({ uid: 1000, gid: 1000 });
  const warm = () => user.statMany?.(["/a/file", "/other"]);
  warm();
  await fs.writeFile("/a/file", "new and longer");
  expect(await new Response(user.readFile("/a/file").stream).text()).toBe("new and longer");
  warm();
  fs.setMetadata("/a/file", { mode: 0o100600 });
  expect(() => user.readFile("/a/file")).toThrow(expect.objectContaining({ code: "EACCES" }));
  warm();
  fs.setOwnership("/a/file", { uid: 1000, gid: 1000 });
  await user.readFile("/a/file").stream.cancel();
  warm();
  fs.setMetadata("/a", { mode: 0o40000 });
  expect(() => user.readFile("/a/file")).toThrow(expect.objectContaining({ code: "EACCES" }));
  fs.setMetadata("/a", { mode: 0o40755 });
  warm();
  await fs.remove("/a/file");
  expect(() => user.readFile("/a/file")).toThrow(expect.objectContaining({ code: "ENOENT" }));
  await fs.writeFile("/replacement", "replacement");
  await fs.writeFile("/a/file", "old");
  warm();
  await fs.move("/replacement", "/a/file", { replace: true });
  expect(await new Response(user.readFile("/a/file").stream).text()).toBe("replacement");
});

it("preserves whole-body snapshots for both single-chunk and multi-chunk batched files", async () => {
  const fs = createTestFileSystem({ chunkBytes: 4 });
  await fs.writeFile("/small", "one");
  await fs.writeFile("/large", "several chunks of content");
  fs.statMany(["/small", "/large"]);
  const small = fs.readFile("/small");
  const large = fs.readFile("/large");
  await fs.writeFile("/small", "replacement");
  await fs.writeFile("/large", "new");
  expect(await new Response(small.stream).text()).toBe("one");
  expect(await new Response(large.stream).text()).toBe("several chunks of content");
  expect(small.stat.sizeBytes).toBe(3);
  expect(large.stat.sizeBytes).toBe(25);
  expect(await new Response(fs.readFile("/small").stream).text()).toBe("replacement");
  expect(await new Response(fs.readFile("/large").stream).text()).toBe("new");
});

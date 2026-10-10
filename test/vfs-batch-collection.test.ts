import { expect, it, vi } from "vitest";
import { readUtf8 } from "../src/vfs/streams.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

it("stores multibyte string batches across byte chunk boundaries", async () => {
  const vfs = createTestFileSystem({ chunkBytes: 7 });
  const body = "🙂é한".repeat(100);
  await vfs.writeFiles([
    { path: "/a", body },
    { path: "/b", body: `${body}tail` },
  ]);
  expect(await readUtf8(vfs.readFile("/a").stream, 4096)).toBe(body);
  expect(await readUtf8(vfs.readFile("/b").stream, 4096)).toBe(`${body}tail`);
});

it("revalidates earlier batch entries after a later string body getter mutates one", async () => {
  const vfs = createTestFileSystem();
  await vfs.writeFile("/a", "before");
  const second = {
    path: "/b",
    get body() {
      void vfs.writeFile("/a", "external");
      return "b";
    },
  };
  await expect(vfs.writeFiles([{ path: "/a", body: "batch" }, second])).rejects.toMatchObject({
    code: "EREVISION",
  });
  expect(await readUtf8(vfs.readFile("/a").stream, 4096)).toBe("external");
  expect(() => vfs.stat("/b")).toThrow(expect.objectContaining({ code: "ENOENT" }));
});

it("releases all string batch leases after exceeding its own in-flight budget", async () => {
  const vfs = createTestFileSystem({ maxInFlightBufferedBytes: 8 });
  await expect(
    vfs.writeFiles([
      { path: "/a", body: "12345" },
      { path: "/b", body: "67890" },
    ]),
  ).rejects.toMatchObject({ code: "ENOSPC" });
  await expect(vfs.writeFile("/c", "12345678")).resolves.toMatchObject({ sizeBytes: 8 });
  expect(() => vfs.stat("/a")).toThrow(expect.objectContaining({ code: "ENOENT" }));
});

it.each(["single", "batch"])(
  "releases the %s lease when incoming digest computation fails",
  async (kind) => {
    const vfs = createTestFileSystem({ maxInFlightBufferedBytes: 8 });
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockRejectedValueOnce(new Error("hash failed"));
    try {
      const write =
        kind === "single"
          ? vfs.writeFile("/a", "12345678", { skipIfUnchanged: true })
          : vfs.writeFiles(
              [
                { path: "/a", body: "1234" },
                { path: "/b", body: "5678" },
              ],
              { skipIfUnchanged: true },
            );
      await expect(write).rejects.toThrow("hash failed");
    } finally {
      digest.mockRestore();
    }
    await expect(vfs.writeFile("/c", "12345678")).resolves.toMatchObject({ sizeBytes: 8 });
  },
);

it("reports advisory write headroom and restores it when read leases close", async () => {
  const vfs = createTestFileSystem({ maxInFlightBufferedBytes: 2048 });
  await vfs.writeFile("/body", new Uint8Array(1024));
  const user = vfs.forCredentials({ uid: 1000, gid: 1000 });
  expect(vfs.availableWriteBufferBytes).toBe(2048);
  const snapshot = vfs.readFile("/body");
  expect(vfs.availableWriteBufferBytes).toBe(1024);
  expect(user.availableWriteBufferBytes).toBe(1024);
  await snapshot.stream.cancel();
  expect(vfs.availableWriteBufferBytes).toBe(2048);
  expect(user.availableWriteBufferBytes).toBe(2048);
});

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { meterSqlStorage } from "../bench/metered-sql.js";
import { createFsAdapter } from "../src/fs/index.js";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { readAllBytes } from "../src/vfs/streams.js";
import type { TestWorkspaceVfs } from "./worker.js";

function workspace(name: string): DurableObjectStub<TestWorkspaceVfs> {
  return env.VFS_TEST.getByName(`byte-${name}`);
}

it.each([3, 100, 1000])(
  "reads a constant number of billed rows when appending to %i chunks",
  async (chunks) => {
    await runInDurableObject(workspace(`append-cost-${chunks}`), async (_instance, state) => {
      const meter = meterSqlStorage(state.storage);
      const fs = new DurableObjectFileSystem(meter.storage, { chunkBytes: 4 });
      await fs.writeFile("/body", "abcd".repeat(chunks));
      meter.reset();
      await fs.appendFile("/body", "e");
      expect({
        statements: meter.statements,
        rowsRead: meter.rowsRead,
        rowsWritten: meter.rowsWritten,
      }).toEqual({ statements: 6, rowsRead: 7, rowsWritten: 3 });
      expect(await createFsAdapter(fs).promises.readFile("/body", "utf8")).toBe(
        `${"abcd".repeat(chunks)}e`,
      );
    });
  },
);

it.each([
  [2, 64],
  [4, 2],
])(
  "preserves snapshots and hard links in string append after width %i becomes %i",
  async (oldWidth, chunkBytes) => {
    await runInDurableObject(
      workspace(`append-width-${oldWidth}-${chunkBytes}`),
      async (_instance, state) => {
        const writer = new DurableObjectFileSystem(state.storage, { chunkBytes: oldWidth });
        await writer.writeFile("/body", "abcdefghij");
        await createFsAdapter(writer).promises.link("/body", "/alias");
        const snapshot = writer.readFile("/body");
        const reopened = new DurableObjectFileSystem(state.storage, { chunkBytes });
        await reopened.appendFile("/alias", "klm");
        const fs = createFsAdapter(reopened).promises;
        expect(await fs.readFile("/body", "utf8")).toBe("abcdefghijklm");
        expect(await fs.readFile("/alias", "utf8")).toBe("abcdefghijklm");
        expect(new TextDecoder().decode(await readAllBytes(snapshot.stream, 20))).toBe(
          "abcdefghij",
        );
        expect((await fs.stat("/alias")).ino).toBe(snapshot.stat.ino);
      },
    );
  },
);

it("keeps hard-link bodies consistent when rewriting with a new chunk width", async () => {
  await runInDurableObject(workspace("linked-width-rewrite"), async (_instance, state) => {
    const writer = new DurableObjectFileSystem(state.storage, { chunkBytes: 2 });
    const adapter = createFsAdapter(writer).promises;
    await adapter.writeFile("/body", "0123456789");
    await adapter.link("/body", "/alias");
    const rewritten = new DurableObjectFileSystem(state.storage, { chunkBytes: 64 });
    await rewritten.writeFile("/alias", "updated");
    const fs = createFsAdapter(rewritten).promises;
    expect(await fs.readFile("/body", "utf8")).toBe("updated");
    expect(await fs.readFile("/alias", "utf8")).toBe("updated");
    expect((await fs.stat("/body")).ino).toBe((await fs.stat("/alias")).ino);
  });
});

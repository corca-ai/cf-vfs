import { describe, expect, it } from "vitest";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { R2ContentReader } from "../src/shell/opaque.js";
import { Shell } from "../src/shell/shell.js";
import type { ShellPolicy } from "../src/shell/types.js";
import type { NodeSqlFileSystem } from "../src/testing/node.js";
import { MemoryOpaqueStore } from "../src/testing/opaque-store.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

const BODY = "alpha\nbeta\ngamma\n";

/**
 * A store that delivers a body in chunks and reports what was actually read.
 *
 * The in-memory store hands the whole body over as one chunk, which cannot
 * distinguish streaming from materializing. Chunking is the only way to see
 * whether a command stops reading when it has what it needs, and whether
 * anything is holding the parts it has already seen.
 */
class ChunkedStore extends MemoryOpaqueStore {
  chunksDelivered = 0;
  liveChunks = 0;
  peakLiveChunks = 0;

  constructor(private readonly chunkBytes = 64 * 1024) {
    super();
  }

  override async getStream(
    key: string,
    range?: { offset: number; length?: number } | { suffix: number },
  ): Promise<ReadableStream<Uint8Array> | null> {
    const whole = await super.getStream(key, range);
    if (whole === null) return null;
    const source = whole.getReader();
    const size = this.chunkBytes;
    const store = this;
    let pending: Uint8Array<ArrayBuffer> = new Uint8Array(0);
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        while (pending.byteLength === 0) {
          const next = await source.read();
          if (next.done) {
            controller.close();
            return;
          }
          pending = next.value as Uint8Array<ArrayBuffer>;
        }
        const chunk = pending.slice(0, size);
        pending = pending.slice(chunk.byteLength);
        store.chunksDelivered += 1;
        store.liveChunks += 1;
        store.peakLiveChunks = Math.max(store.peakLiveChunks, store.liveChunks);
        controller.enqueue(chunk);
        // The consumer has taken the previous chunk by the time it asks again.
        store.liveChunks -= 1;
      },
      async cancel(reason) {
        await source.cancel(reason);
      },
    });
  }
}

/** A filesystem holding one opaque object and one inline file. */
async function withOpaque(options: { store?: MemoryOpaqueStore } = {}): Promise<{
  fileSystem: NodeSqlFileSystem;
  store: MemoryOpaqueStore;
}> {
  const store = options.store ?? new MemoryOpaqueStore();
  const fileSystem = createTestFileSystem({ opaqueStore: store });
  await fileSystem.writeFile("/inline.txt", "inline\n");
  const upload = await fileSystem.beginOpaqueUpload("/blob.txt");
  await store.putIfAbsent(upload.objectKey, BODY);
  await fileSystem.commitOpaqueUpload(upload.uploadId);
  return { fileSystem, store };
}

function shellFor(
  fileSystem: NodeSqlFileSystem,
  store: MemoryOpaqueStore,
  policy: ShellPolicy = { opaqueContent: "stream" },
): Shell {
  return new Shell({
    fileSystem,
    commands: defaultShellCommands,
    content: new R2ContentReader(fileSystem, store),
    policy,
  });
}

describe("opaque content", () => {
  it("keeps opaque bodies unreadable unless a host opts in", async () => {
    const { fileSystem } = await withOpaque();
    // No capability: exactly the behavior every existing caller has.
    const plain = new Shell({ fileSystem, commands: defaultShellCommands });
    const refused = await plain.executeText({ script: "cat /blob.txt" });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("opaque R2 content is not available");
    // The entry is still named and described, which is what `metadata` means.
    expect((await plain.executeText({ script: "ls /" })).stdout).toBe("blob.txt\ninline.txt\n");
    expect((await plain.executeText({ script: "stat -c '%s %F' /blob.txt" })).stdout).toBe(
      "17 regular file\n",
    );
  });

  it("requires the policy as well as the capability", async () => {
    const { fileSystem, store } = await withOpaque();
    // The capability alone must not widen what a scoped session can read:
    // adding it to a host is not a decision about every session on it.
    const shell = shellFor(fileSystem, store, {});
    const refused = await shell.executeText({ script: "cat /blob.txt" });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("opaque R2 content is not available");

    const denied = shellFor(fileSystem, store, { opaqueContent: "metadata" });
    expect((await denied.executeText({ script: "cat /blob.txt" })).exitCode).not.toBe(0);
    // And `none` does not change what metadata already answered; it is the
    // read roots that decide whether a path can be named at all.
    const off = shellFor(fileSystem, store, { opaqueContent: "none" });
    expect((await off.executeText({ script: "cat /blob.txt" })).exitCode).not.toBe(0);
  });

  it("streams an opaque body through the commands that consume as they go", async () => {
    const { fileSystem, store } = await withOpaque();
    const shell = shellFor(fileSystem, store);
    expect((await shell.executeText({ script: "cat /blob.txt" })).stdout).toBe(BODY);
    expect((await shell.executeText({ script: "head -n 1 /blob.txt" })).stdout).toBe("alpha\n");
    expect((await shell.executeText({ script: "grep beta /blob.txt" })).stdout).toBe("beta\n");
    expect((await shell.executeText({ script: "wc -l /blob.txt" })).stdout).toBe("3 /blob.txt\n");
    // Mixed with an inline file and with standard input, in one invocation.
    expect((await shell.executeText({ script: "cat /inline.txt /blob.txt | wc -l" })).stdout).toBe(
      "4\n",
    );
  });

  it("keeps a barrier command refusing an opaque body", async () => {
    const { fileSystem, store } = await withOpaque();
    const shell = shellFor(fileSystem, store);
    // These have to hold all of their input, and an opaque body is stored
    // opaquely precisely because it is too large to hold. A refusal a caller
    // can act on beats an execution that dies against a limit halfway through.
    for (const script of [
      "sort /blob.txt",
      "diff /blob.txt /inline.txt",
      "sed -i 's/a/b/' /blob.txt",
      "x=$(cat /blob.txt < /blob.txt)",
    ]) {
      const result = await shell.executeText({ script });
      expect(result.exitCode, script).not.toBe(0);
    }
  });

  it("never materializes the body", async () => {
    const { fileSystem, store } = await withOpaque();
    const shell = shellFor(fileSystem, store);
    // A body far larger than the inline limit streams through without being
    // held: materializing it would exceed the limit that made it opaque.
    const large = "x".repeat(12 * 1024 * 1024);
    const upload = await fileSystem.beginOpaqueUpload("/large.bin");
    await store.putIfAbsent(upload.objectKey, large);
    await fileSystem.commitOpaqueUpload(upload.uploadId);

    const counted = await shell.executeText({ script: "wc -c /large.bin" });
    expect(counted.exitCode).toBe(0);
    expect(counted.stdout).toBe(`${large.length} /large.bin\n`);
    // The same body through a barrier is refused rather than buffered.
    expect((await shell.executeText({ script: "sort /large.bin" })).exitCode).not.toBe(0);
  });

  it("stops reading a body once a command has what it needs", async () => {
    const store = new ChunkedStore();
    const fileSystem = createTestFileSystem({ opaqueStore: store });
    const upload = await fileSystem.beginOpaqueUpload("/big.bin");
    await store.putIfAbsent(upload.objectKey, `first\n${"x".repeat(4 * 1024 * 1024)}\n`);
    await fileSystem.commitOpaqueUpload(upload.uploadId);

    const shell = shellFor(fileSystem, store);
    const result = await shell.executeText({ script: "head -n 1 /big.bin" });
    expect(result.stdout).toBe("first\n");
    // Backpressure is real: a 4 MiB body in 64 KiB chunks is 64 chunks, and a
    // command that wanted one line must not have pulled them all.
    expect(store.chunksDelivered).toBeGreaterThan(0);
    expect(store.chunksDelivered).toBeLessThan(4);
    // Nothing accumulates: at most one chunk is in flight at a time.
    expect(store.peakLiveChunks).toBe(1);
  });

  it("reads a whole body in bounded memory", async () => {
    const store = new ChunkedStore();
    const fileSystem = createTestFileSystem({ opaqueStore: store });
    const size = 12 * 1024 * 1024;
    const upload = await fileSystem.beginOpaqueUpload("/large.bin");
    await store.putIfAbsent(upload.objectKey, "x".repeat(size));
    await fileSystem.commitOpaqueUpload(upload.uploadId);

    const shell = shellFor(fileSystem, store);
    const counted = await shell.executeText({ script: "wc -c /large.bin" });
    expect(counted.stdout).toBe(`${size} /large.bin\n`);
    // Every chunk was needed, and none were held: a body chosen for being too
    // large to store inline passed through without being assembled.
    expect(store.chunksDelivered).toBeGreaterThan(100);
    expect(store.peakLiveChunks).toBe(1);
  });

  it("asks for only the bytes a range-aware command needs", async () => {
    const store = new ChunkedStore();
    const requested: unknown[] = [];
    const fileSystem = createTestFileSystem({ opaqueStore: store });
    const upload = await fileSystem.beginOpaqueUpload("/big.bin");
    await store.putIfAbsent(upload.objectKey, "x".repeat(4 * 1024 * 1024));
    await fileSystem.commitOpaqueUpload(upload.uploadId);
    const inner = store.getStream.bind(store);
    store.getStream = async (key, range) => {
      requested.push(range);
      return inner(key, range);
    };

    const shell = shellFor(fileSystem, store);
    expect((await shell.executeText({ script: "head -c 8 /big.bin" })).stdout).toBe("xxxxxxxx");
    // The store was asked for eight bytes rather than four megabytes.
    expect(requested).toEqual([{ offset: 0, length: 8 }]);
    expect(store.chunksDelivered).toBe(1);

    // A command with no range still asks for the whole body.
    requested.length = 0;
    await shell.executeText({ script: "wc -c /big.bin" });
    expect(requested).toEqual([undefined]);
  });

  it("performs the R2 read outside every SQL transaction", async () => {
    const store = new MemoryOpaqueStore();
    let depth = 0;
    let sawTransaction = false;
    let readsInsideTransaction = 0;
    const fileSystem = createTestFileSystem({
      opaqueStore: store,
      onStatement: (query) => {
        if (query.trim() === "BEGIN") {
          depth += 1;
          sawTransaction = true;
        }
        if (query.trim() === "COMMIT" || query.trim() === "ROLLBACK") depth -= 1;
      },
    });
    await fileSystem.writeFile("/inline.txt", "inline\n");
    const upload = await fileSystem.beginOpaqueUpload("/blob.txt");
    await store.putIfAbsent(upload.objectKey, BODY);
    await fileSystem.commitOpaqueUpload(upload.uploadId);

    const inner = store.getStream.bind(store);
    store.getStream = async (key, range) => {
      if (depth > 0) readsInsideTransaction += 1;
      return inner(key, range);
    };
    // Prove the meter actually observes transactions before asserting a zero.
    await fileSystem.writeFile("/probe.txt", "x\n");
    expect(sawTransaction).toBe(true);
    expect(depth).toBe(0);

    const shell = shellFor(fileSystem, store);
    expect((await shell.executeText({ script: "cat /blob.txt" })).stdout).toBe(BODY);
    // A bucket round trip inside a transaction would hold the Durable Object's
    // storage lock for the length of a network call.
    expect(readsInsideTransaction).toBe(0);
  });

  it("reports a body that disappeared rather than reading it as empty", async () => {
    const { fileSystem, store } = await withOpaque();
    const shell = shellFor(fileSystem, store);
    store.getStream = async () => null;
    const result = await shell.executeText({ script: "cat /blob.txt" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("missing from storage");
  });

  it("takes a retention lease before reading", async () => {
    const { fileSystem, store } = await withOpaque();
    const before = fileSystem.stat("/blob.txt");
    const shell = shellFor(fileSystem, store);
    expect((await shell.executeText({ script: "cat /blob.txt" })).stdout).toBe(BODY);
    // The read leaves the entry alone; the lease is on the object behind it.
    expect(fileSystem.stat("/blob.txt")).toMatchObject({
      revision: before.revision,
      sizeBytes: before.sizeBytes,
    });
    // And an unlinked object stays readable for the life of an open lease.
    const lease = fileSystem.resolveOpaqueRead("/blob.txt");
    await fileSystem.remove("/blob.txt");
    await fileSystem.drainGarbage();
    await expect(store.getStream(lease.object.key)).resolves.not.toBeNull();
  });
});

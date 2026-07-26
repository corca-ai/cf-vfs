import { describe, expect, it } from "vitest";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { R2ContentReader } from "../src/shell/opaque.js";
import { Shell } from "../src/shell/shell.js";
import type { ShellCommand, ShellCommandContext, ShellPolicy } from "../src/shell/types.js";
import type { NodeSqlFileSystem } from "../src/testing/node.js";
import { MemoryOpaqueStore } from "../src/testing/opaque-store.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

const BODY = "alpha\nbeta\ngamma\n";

/**
 * A store that delivers a body in chunks and reports what a consumer pulled.
 *
 * The in-memory store hands a body over as one chunk, which cannot distinguish
 * streaming from materializing. Chunking shows whether a command stops reading
 * once it has what it needs.
 *
 * `inFlight` counts chunks the store has enqueued that the consumer has not
 * taken yet. Counting inside `pull` would be meaningless — a stream never
 * calls `pull` reentrantly, so any consumer, including one materializing the
 * whole body, would report one. The count is decremented by the consumer side
 * of a transform placed between the store and the command, so it measures
 * queueing rather than the shape of the loop.
 */
class ChunkedStore extends MemoryOpaqueStore {
  chunksDelivered = 0;
  gets = 0;
  inFlight = 0;
  peakInFlight = 0;

  constructor(private readonly chunkBytes = 64 * 1024) {
    super();
  }

  override async getStream(
    key: string,
    range?: { offset: number; length?: number } | { suffix: number },
  ): Promise<ReadableStream<Uint8Array> | null> {
    const whole = await super.getStream(key, range);
    if (whole === null) return null;
    this.gets += 1;
    const source = whole.getReader();
    const size = this.chunkBytes;
    const store = this;
    let pending: Uint8Array<ArrayBuffer> = new Uint8Array(0);
    const chunked = new ReadableStream<Uint8Array>({
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
        store.inFlight += 1;
        store.peakInFlight = Math.max(store.peakInFlight, store.inFlight);
        controller.enqueue(chunk);
      },
      async cancel(reason) {
        await source.cancel(reason);
      },
    });
    // The consumer end: a chunk stops being in flight when it is taken.
    return chunked.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          store.inFlight -= 1;
          controller.enqueue(chunk);
        },
      }),
    );
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
    expect((await plain.executeText({ script: "ls /" })).stdout).toBe(
      "bin\nblob.txt\ndev\ninline.txt\nusr\n",
    );
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
    // Naming a path at all is what the read roots decide, which is why there
    // is no third value here that would do the same thing.
    expect((await denied.executeText({ script: "stat -c '%F' /blob.txt" })).exitCode).toBe(0);
  });

  it("checks credential-bound read permission before opening R2", async () => {
    const store = new ChunkedStore();
    const { fileSystem } = await withOpaque({ store });
    fileSystem.setOwnership("/blob.txt", { uid: 1_000, gid: 1_000 });
    fileSystem.setMetadata("/blob.txt", { mode: 0o100000 });
    const shell = shellFor(fileSystem, store);

    const refused = await shell.executeText({
      script: "cat /blob.txt",
      credentials: { uid: 1_000, gid: 1_000 },
    });
    expect(refused).toMatchObject({
      exitCode: 126,
      stderr: expect.stringContaining("permission denied"),
    });
    expect(store.gets).toBe(0);
  });

  it("keeps the capability inside the session's read roots", async () => {
    const { fileSystem, store } = await withOpaque();
    await fileSystem.mkdir("/allowed", true);
    const upload = await fileSystem.beginOpaqueUpload("/allowed/ok.bin");
    await store.putIfAbsent(upload.objectKey, BODY);
    await fileSystem.commitOpaqueUpload(upload.uploadId);

    // An applet reaching the raw capability, which is what a third-party
    // command in the registry can do. The reader a host supplies is built over
    // the unscoped filesystem, so without a session's roots on it this would
    // be a read capability with none.
    let reached: string | undefined;
    const probe: ShellCommand = {
      name: "probe",
      run(context: ShellCommandContext, argv: readonly string[]) {
        return {
          completed: (async (): Promise<{ exitCode: number }> => {
            const body = await context.content?.open(argv[0] ?? "");
            reached = body === undefined ? undefined : await new Response(body.stream).text();
            return { exitCode: 0 };
          })(),
        };
      },
    };
    const shell = new Shell({
      fileSystem,
      commands: [...defaultShellCommands, probe],
      content: new R2ContentReader(fileSystem, store),
      policy: { readRoots: ["/allowed"], opaqueContent: "stream" },
    });

    expect((await shell.executeText({ script: "cat /allowed/ok.bin" })).stdout).toBe(BODY);
    expect((await shell.executeText({ script: "probe /allowed/ok.bin" })).exitCode).toBe(0);
    expect(reached).toBe(BODY);

    reached = undefined;
    const denied = await shell.executeText({ script: "probe /blob.txt" });
    expect(denied.exitCode).not.toBe(0);
    expect(denied.stderr).toContain("outside the readable roots");
    expect(reached).toBeUndefined();
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
      "comm /blob.txt /inline.txt",
      "paste /blob.txt",
      "tail -n 1 /blob.txt",
      "cmp /blob.txt /inline.txt",
    ]) {
      const result = await shell.executeText({ script });
      expect(result.exitCode, script).not.toBe(0);
      expect(result.stderr, script).toContain("opaque R2 content is not available");
    }
  });

  it("captures a streamed body in a command substitution, bounded by its own limit", async () => {
    const { fileSystem, store } = await withOpaque();
    const shell = shellFor(fileSystem, store);
    // Command substitution is not a barrier on the *input*: `cat` streams the
    // body and the substitution buffers `cat`'s output, exactly as it does for
    // an inline file. Its own limit is what bounds it.
    const captured = await shell.executeText({ script: 'x=$(cat /blob.txt); printf "%s" "${#x}"' });
    expect(captured.exitCode).toBe(0);
    expect(captured.stdout).toBe(String(BODY.trimEnd().length));

    const upload = await fileSystem.beginOpaqueUpload("/large.bin");
    await store.putIfAbsent(upload.objectKey, "x".repeat(4 * 1024 * 1024));
    await fileSystem.commitOpaqueUpload(upload.uploadId);
    const refused = await shell.executeText({ script: "x=$(cat /large.bin)" });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("command substitution exceeds");
  });

  it("opens a body the same way however the input is spelled", async () => {
    const { fileSystem, store } = await withOpaque();
    await fileSystem.mkdir("/dir", true);
    const upload = await fileSystem.beginOpaqueUpload("/dir/nested.bin");
    await store.putIfAbsent(upload.objectKey, BODY);
    await fileSystem.commitOpaqueUpload(upload.uploadId);
    const shell = shellFor(fileSystem, store);
    // An operand, a redirection, and a recursive walk are three spellings of
    // the same request and must not disagree about what they can open.
    expect((await shell.executeText({ script: "wc -l /blob.txt" })).stdout).toBe("3 /blob.txt\n");
    expect((await shell.executeText({ script: "wc -l < /blob.txt" })).stdout).toBe("3\n");
    expect((await shell.executeText({ script: "grep -r beta /dir" })).stdout).toBe(
      "/dir/nested.bin:beta\n",
    );
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
    const build = async (): Promise<{ store: ChunkedStore; shell: Shell }> => {
      const store = new ChunkedStore();
      const fileSystem = createTestFileSystem({ opaqueStore: store });
      const upload = await fileSystem.beginOpaqueUpload("/big.bin");
      await store.putIfAbsent(upload.objectKey, `first\n${"x".repeat(4 * 1024 * 1024)}\n`);
      await fileSystem.commitOpaqueUpload(upload.uploadId);
      return { store, shell: shellFor(fileSystem, store) };
    };

    const early = await build();
    expect((await early.shell.executeText({ script: "head -n 1 /big.bin" })).stdout).toBe(
      "first\n",
    );
    const whole = await build();
    expect((await whole.shell.executeText({ script: "wc -c /big.bin" })).exitCode).toBe(0);

    // The comparison is the point: the same body, the same store, one command
    // that wanted a line and one that wanted all of it.
    expect(whole.store.chunksDelivered).toBeGreaterThan(60);
    expect(early.store.chunksDelivered).toBeLessThan(whole.store.chunksDelivered / 10);
    // And neither queued more than the stream's own buffering, so no consumer
    // is accumulating what it has already been handed.
    expect(early.store.peakInFlight).toBeLessThanOrEqual(4);
    expect(whole.store.peakInFlight).toBeLessThanOrEqual(4);
    // One GET for the body, not one per chunk.
    expect(whole.store.gets).toBe(1);
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
    // Every chunk was needed, and none accumulated: a body chosen for being
    // too large to store inline passed through without being assembled.
    expect(store.chunksDelivered).toBeGreaterThan(100);
    expect(store.peakInFlight).toBeLessThanOrEqual(4);
    expect(store.gets).toBe(1);
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

  it("stops waiting when the execution is cancelled before the first byte", async () => {
    const { fileSystem, store } = await withOpaque();
    // A bucket that never answers must not leave the execution pending: this
    // is the first place a command awaits the network.
    store.getStream = () => new Promise(() => undefined);
    const shell = shellFor(fileSystem, store);
    const controller = new AbortController();
    const started = Date.now();
    const running = shell.executeText({ script: "cat /blob.txt", signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const result = await running;
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reports a transfer failure rather than rejecting the execution", async () => {
    const { fileSystem, store } = await withOpaque();
    const shell = shellFor(fileSystem, store);
    // A 500 or a dropped connection is ordinary bucket behavior, not a broken
    // invariant, so it has to arrive as a status and a diagnostic.
    store.getStream = async () => {
      throw new Error("R2 GET failed: 500");
    };
    const failed = await shell.executeText({ script: "cat /blob.txt" });
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stderr).toContain("opaque body could not be read");

    store.getStream = async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
          controller.error(new Error("connection reset"));
        },
      });
    const midRead = await shell.executeText({ script: "cat /blob.txt" });
    expect(midRead.exitCode).not.toBe(0);
    expect(midRead.stderr).toContain("opaque body could not be read");
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

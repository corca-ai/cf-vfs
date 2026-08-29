import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isVfsError, type VfsError } from "../src/core/errors.js";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { readAllBytes } from "../src/vfs/streams.js";
import { runVfsConformance, streamThatFailsAfter } from "./helpers/vfs-conformance.js";
import type { TestWorkspaceVfs } from "./worker.js";

function workspace(name: string): DurableObjectStub<TestWorkspaceVfs> {
  return env.VFS_TEST.getByName(`byte-${name}`);
}

describe("shared VFS conformance", () => {
  let conformanceId = 0;
  runVfsConformance(() => workspace(`conformance-${conformanceId++}`), {
    negativeMutationRaces: false,
    failedInputStreams: false,
  });
});

it("stores arbitrary chunked bytes and returns a stable stream snapshot", async () => {
  const stub = workspace("inline-snapshot");
  const original = new Uint8Array(3000);
  original[0] = 0xff;
  original[2999] = 0x7f;
  await stub.writeFile("/data", original);
  const snapshot = await stub.readFile("/data");
  await stub.writeFile("/data", new Uint8Array([9]));

  expect([...(await readAllBytes(snapshot.stream, 4096))]).toEqual([...original]);
  expect([...(await readAllBytes((await stub.readFile("/data")).stream, 16))]).toEqual([9]);
  await runInDurableObject(stub, (_instance, state) => {
    const chunks = state.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM vfs_inline_chunks")
      .one().count;
    expect(chunks).toBe(1);
  });
});

it("ranges bodies written with a different chunk size", async () => {
  const stub = workspace("range-reconfigured-chunks");
  const result = await runInDurableObject(stub, async (_instance, state) => {
    const writer = new DurableObjectFileSystem(state.storage, { chunkBytes: 2 });
    await writer.writeFile(
      "/small",
      Uint8Array.from({ length: 10 }, (_, index) => index),
    );
    await writer.writeFile(
      "/large",
      Uint8Array.from({ length: 20 }, (_, index) => index),
    );

    const smallReader = new DurableObjectFileSystem(state.storage, { chunkBytes: 64 });
    const small = await readAllBytes(
      smallReader.readFile("/small", { range: { offset: 3, length: 5 } }).stream,
      10,
    );
    const largeReader = new DurableObjectFileSystem(state.storage, { chunkBytes: 8 });
    const large = await readAllBytes(
      largeReader.readFile("/large", { range: { suffix: 5 } }).stream,
      20,
    );
    return { small: [...small], large: [...large] };
  });

  expect(result).toEqual({ small: [3, 4, 5, 6, 7], large: [15, 16, 17, 18, 19] });
});

it("returns RPC byte streams that support BYOB readers", async () => {
  const stub = workspace("rpc-byob");
  await stub.writeFile("/bytes", Uint8Array.of(1, 2, 3));
  const reader = (await stub.readFile("/bytes")).stream.getReader({ mode: "byob" });
  const first = await reader.read(new Uint8Array(3));
  expect(first.done).toBe(false);
  expect([...(first.value ?? new Uint8Array())]).toEqual([1, 2, 3]);
  await reader.cancel();
});

it("keeps SQLite bytes independent from chunks transferred inside the object", async () => {
  const stub = workspace("owned-inline-read");
  const stored = await runInDurableObject(stub, async (instance) => {
    await instance.writeFile("/bytes", Uint8Array.of(1, 2, 3));
    const reader = instance.readFile("/bytes").stream.getReader();
    const first = await reader.read();
    if (first.done) throw new Error("inline read returned no bytes");
    first.value.fill(9);
    await reader.cancel();
    return [...(await readAllBytes(instance.readFile("/bytes").stream, 16))];
  });

  expect(stored).toEqual([1, 2, 3]);
});

it("preserves VfsError discrimination across the RPC boundary", async () => {
  const stub = workspace("rpc-error-shape");

  // Workers RPC rebuilds a thrown error as a plain Error: the own properties
  // survive but the prototype does not. `runInDurableObject` never crosses
  // that boundary, so this must call the stub directly.
  let synchronous: unknown;
  try {
    await stub.stat("/definitely-missing");
  } catch (error) {
    synchronous = error;
  }
  expect(isVfsError(synchronous)).toBe(true);
  expect(synchronous).toMatchObject({
    name: "VfsError",
    code: "ENOENT",
    path: "/definitely-missing",
  });

  await stub.writeFile("/taken", "body");
  let asynchronous: unknown;
  try {
    await stub.writeFile("/taken", "other", { disposition: "create" });
  } catch (error) {
    asynchronous = error;
  }
  expect(isVfsError(asynchronous)).toBe(true);
  expect((asynchronous as VfsError).code).toBe("EEXIST");

  let shellError: unknown;
  try {
    await stub.executeText({ script: "echo hi", cwd: 42 as unknown as string });
  } catch (error) {
    shellError = error;
  }
  expect(isVfsError(shellError)).toBe(true);
  expect((shellError as VfsError).code).toBe("EINVAL");

  expect(isVfsError(new Error("plain"))).toBe(false);
  const accessor = new Error("foreign");
  accessor.name = "VfsError";
  Object.defineProperty(accessor, "code", {
    get() {
      throw new Error("accessor must not run");
    },
  });
  expect(isVfsError(accessor)).toBe(false);
  expect(isVfsError({ name: "VfsError", code: "ENOENT" })).toBe(false);
  expect(
    isVfsError(
      Object.assign(new Error("spoofed"), {
        name: "VfsError",
        code: "ENOTACODE",
      }),
    ),
  ).toBe(false);
});

it("rejects self-copy and a stale empty append atomically inside the object", async () => {
  const stub = workspace("mutation-races");
  const result = await runInDurableObject(stub, async (instance) => {
    await instance.writeFile("/same", "body");
    let copyError: unknown;
    try {
      await instance.copy("/same", "/same", { replace: true });
    } catch (error) {
      copyError = error;
    }

    let finish: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        finish = () => controller.close();
      },
    });
    const appending = instance.appendFile("/same", body);
    const observed = appending.then(
      () => null,
      (error: unknown) => error,
    );
    await Promise.resolve();
    instance.touch("/same");
    finish?.();
    return { copyError, appendError: await observed, stat: instance.stat("/same") };
  });
  expect(result.copyError).toMatchObject({ code: "EINVAL", path: "/same" });
  expect(result.appendError).toMatchObject({ code: "EREVISION", path: "/same" });
  expect(result.stat.sizeBytes).toBe(4);
});

it("publishes no partial generation when an input stream fails inside the object", async () => {
  const stub = workspace("failed-stream");
  const result = await runInDurableObject(stub, async (instance) => {
    let createError: unknown;
    try {
      await instance.writeFile("/new", streamThatFailsAfter("partial"));
    } catch (caught) {
      createError = caught;
    }
    const pathsAfterCreate = instance.list("/").map((entry) => entry.path);

    await instance.writeFile("/file", "old");
    let replaceError: unknown;
    try {
      await instance.writeFile("/file", streamThatFailsAfter("partial"));
    } catch (caught) {
      replaceError = caught;
    }
    const body = await readAllBytes(instance.readFile("/file").stream, 16);
    return {
      createError,
      pathsAfterCreate,
      replaceError,
      body: new TextDecoder().decode(body),
    };
  });

  expect(result.createError).toEqual(expect.objectContaining({ message: "source failed" }));
  expect(result.pathsAfterCreate).not.toContain("/new");
  expect(result.replaceError).toEqual(expect.objectContaining({ message: "source failed" }));
  expect(result.body).toBe("old");
});

it("enforces schema combinations with CHECK constraints", async () => {
  const stub = workspace("schema-checks");
  await stub.writeFile("/initialize", "x");
  await expect(
    runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO vfs_entries (
         path, parent_path, name, kind, content_class, opaque_object_id,
         size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision
       ) VALUES ('/bad', '/', 'bad', 'directory', 'inline', NULL,
                 0, 16877, 0, 0, 1, 1, 1)`,
      );
    }),
  ).rejects.toThrow();
});

it("skips schema initialization after migration version 1 is present", async () => {
  const stub = workspace("schema-migration-gate");
  await stub.writeFile("/initialized", "x");
  const createdIds = await runInDurableObject(stub, (_instance, state) => {
    let count = 0;
    new DurableObjectFileSystem(state.storage, {
      createId: () => `unexpected-${count++}`,
    });
    return count;
  });
  expect(createdIds).toBe(0);
});

it("uses integer entry IDs and epoch-version mutation tokens", async () => {
  const stub = workspace("compact-schema-identities");
  await stub.writeFile("/file", "body");
  const result = await runInDurableObject(stub, (instance, state) => {
    const row = state.storage.sql
      .exec<{
        id: number;
        id_type: string;
        mutation_epoch: string;
        version: number;
      }>(
        `SELECT e.id, typeof(e.id) AS id_type, s.mutation_epoch,
                e.mutation_version AS version
       FROM vfs_entries e
       JOIN vfs_state s ON s.singleton = 1
       WHERE e.path = '/file'`,
      )
      .one();
    return { row, stat: instance.stat("/file") };
  });

  expect(result.row.id).toBeGreaterThan(0);
  expect(result.row.id_type).toBe("integer");
  expect(result.stat.mutationToken).toBe(`${result.row.mutation_epoch}:${result.row.version}`);
});

it("rejects malformed RPC booleans before destructive operations", async () => {
  const stub = workspace("rpc-validation");
  const result = await runInDurableObject(stub, async (instance) => {
    instance.mkdir("/dir");
    await instance.writeFile("/dir/file", "body");
    let error: unknown;
    try {
      await instance.remove("/dir", { recursive: "false" } as never);
    } catch (caught) {
      error = caught;
    }
    return { error, stat: instance.stat("/dir/file") };
  });
  expect(result.error).toMatchObject({ code: "EINVAL" });
  expect(result.stat.path).toBe("/dir/file");
});

it("rejects unsupported read options at the RPC boundary", async () => {
  const stub = workspace("read-rpc-validation");
  const error = await runInDurableObject(stub, async (instance) => {
    await instance.writeFile("/file", "body");
    try {
      instance.readFile("/file", { unexpected: true } as never);
    } catch (caught) {
      return caught;
    }
    return null;
  });
  expect(error).toMatchObject({ code: "EINVAL", message: "options.unexpected is not supported" });
});

it("rejects a malformed batch before writing any entry", async () => {
  const stub = workspace("batch-rpc-validation");
  const result = await runInDurableObject(stub, async (instance) => {
    let error: unknown;
    try {
      await instance.writeFiles([
        { path: "/valid", body: "body" },
        { path: "/invalid", body: { not: "bytes" } },
      ] as never);
    } catch (caught) {
      error = caught;
    }
    return { error, entries: instance.list("/").length };
  });

  expect(result.error).toMatchObject({
    code: "EINVAL",
    message: "entries[1].body must be bytes, text, or a byte stream",
  });
  expect(result.entries).toBe(0);
});

it("rejects POSIX IDs outside the SQLite uint32 range at the RPC boundary", async () => {
  const stub = workspace("shell-rpc-posix-id-range");
  const error = await runInDurableObject(stub, async (instance) => {
    try {
      await instance.executeText({
        script: "echo unreachable",
        credentials: { uid: 0x1_0000_0000, gid: 1 },
      } as never);
      return null;
    } catch (caught) {
      return caught;
    }
  });
  expect(error).toMatchObject({ code: "EINVAL" });
});

it("fails writes before the configured SQLite headroom is consumed", async () => {
  const stub = workspace("database-headroom");
  await stub.writeFile("/initialize", "x");
  const error = await runInDurableObject(stub, async (_instance, state) => {
    const fileSystem = new DurableObjectFileSystem(state.storage, {
      maxDatabaseBytes: state.storage.sql.databaseSize,
      minDatabaseHeadroomBytes: 1,
    });
    try {
      await fileSystem.writeFile("/blocked", "body");
      return null;
    } catch (caught) {
      return caught;
    }
  });
  expect(error).toMatchObject({ code: "ENOSPC", path: "/blocked" });
  const statError = await runInDurableObject(stub, (instance) => {
    try {
      return instance.stat("/blocked");
    } catch (caught) {
      return caught;
    }
  });
  expect(statError).toMatchObject({ code: "ENOENT", path: "/blocked" });
});

it("keeps the SQLite headroom refusal on a same-size replacement", async () => {
  const stub = workspace("database-headroom-same-size");
  await stub.writeFile("/file", "old!");
  const result = await runInDurableObject(stub, async (_instance, state) => {
    const fileSystem = new DurableObjectFileSystem(state.storage, {
      maxDatabaseBytes: state.storage.sql.databaseSize,
      minDatabaseHeadroomBytes: 1,
    });
    try {
      await fileSystem.writeFile("/file", "new!");
      return { error: null, body: "" };
    } catch (caught) {
      const body = new TextDecoder().decode(
        await readAllBytes(fileSystem.readFile("/file").stream, 16),
      );
      return { error: caught, body };
    }
  });
  expect(result.error).toMatchObject({ code: "ENOSPC", path: "/file" });
  expect(result.body).toBe("old!");
});

it("rejects chunks that approach the Durable Object SQLite row limit", async () => {
  const stub = workspace("sqlite-chunk-limit");
  const error = await runInDurableObject(stub, (_instance, state) => {
    try {
      new DurableObjectFileSystem(state.storage, {
        chunkBytes: 2 * 1024 * 1024,
      });
      return null;
    } catch (caught) {
      return caught;
    }
  });
  expect(error).toMatchObject({
    code: "EINVAL",
    message: "chunkBytes cannot exceed 1048576 for SQLite storage",
  });
});

it("does not create tombstones for absent token reads", async () => {
  const stub = workspace("absent-token-read");
  const result = await runInDurableObject(stub, (instance, state) => {
    const before = state.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM vfs_path_tombstones")
      .one().count;
    const first = instance.getMutationToken("/never-created");
    const second = instance.getMutationToken("/another-absent");
    const after = state.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM vfs_path_tombstones")
      .one().count;
    return { before, after, first, second };
  });
  expect(result.after).toBe(result.before);
  expect(result.first).toBe(result.second);
});

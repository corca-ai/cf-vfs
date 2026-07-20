import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ExecuteRequest, ExecuteResult } from "../src/core/command.js";
import { R2BinaryStore } from "../src/storage/r2.js";
import type { TestWorkspaceVfs } from "./worker.js";

function workspace(name: string): DurableObjectStub<TestWorkspaceVfs> {
  return env.VFS_TEST.getByName(name);
}

async function execute(
  stub: DurableObjectStub<TestWorkspaceVfs>,
  request: ExecuteRequest,
): Promise<ExecuteResult> {
  return stub.execute(request);
}

describe("SQLite Durable Object filesystem", () => {
  it("rejects SQLite rows whose columns form an impossible entry state", async () => {
    const stub = workspace("invalid-entry-state");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO vfs_entries (
           path, parent_path, name, kind, content_kind, content_state,
           size_bytes, line_count, word_count, mode, created_at_ms,
           modified_at_ms, revision, r2_key
         ) VALUES ('/corrupt', '/', 'corrupt', 'directory', 'text', 'active',
                   0, 0, 0, 16877, 1, 1, 1, NULL)`,
      );
    });

    expect(await execute(stub, { command: "stat", input: { path: "/corrupt" } })).toMatchObject({
      exitCode: 1,
      data: { code: "EIO", path: "/corrupt" },
    });
  });

  it("reassembles chunked SQLite text for metadata and tail reads", async () => {
    const stub = workspace("text-commands");
    const text = `${"alpha 123\n".repeat(400)}omega 999\n`;
    const write = await execute(stub, {
      command: "write",
      input: { path: "/repo/logs/app.log", text, createParents: true },
    });
    expect(write.exitCode).toBe(0);

    const chunkCount = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM vfs_text_chunks WHERE path = '/repo/logs/app.log'",
      ).one().count);
    expect(chunkCount).toBeGreaterThan(1);

    const stat = await execute(stub, { command: "stat", input: { path: "/repo/logs/app.log" } });
    expect(stat.stdout).toContain(`Size: ${new TextEncoder().encode(text).byteLength}`);

    const tail = await execute(stub, {
      command: "tail",
      input: { path: "/repo/logs/app.log", lines: 1 },
    });
    expect(tail.stdout).toBe("omega 999\n");
  });

  it("uses revisions as compare-and-swap guards", async () => {
    const stub = workspace("revision-guard");
    const first = await execute(stub, {
      command: "write",
      input: { path: "/state.txt", text: "one" },
    });
    const revision = (first.data as { revision: number }).revision;

    expect((await execute(stub, {
      command: "write",
      input: { path: "/state.txt", text: "two", ifRevision: revision },
    })).exitCode).toBe(0);

    const stale = await execute(stub, {
      command: "write",
      input: { path: "/state.txt", text: "stale", ifRevision: revision },
    });
    expect(stale.exitCode).toBe(1);
    expect(stale.data).toEqual({ code: "EREVISION", path: "/state.txt" });
  });

  it("keeps immutable binary bodies in R2 and supports range reads", async () => {
    const stub = workspace("binary-r2");
    const bytes = new Uint8Array([10, 20, 30, 40, 50]);
    const written = await stub.putBinary("/assets/data.bin", bytes.buffer, {
      createParents: true,
    });

    const partial = await stub.readBinary("/assets/data.bin", { offset: 1, length: 3 });
    expect([...new Uint8Array(partial.bytes)]).toEqual([20, 30, 40]);
    expect((await env.VFS_TEST_BUCKET.get(written.objectKey))?.size).toBe(5);
  });

  it("rejects overlapping R2 range forms at the runtime boundary", async () => {
    // Deliberately bypass the static union to verify the public RPC boundary.
    await expect(new R2BinaryStore(env.VFS_TEST_BUCKET).get(
      "range-validation",
      { offset: 1, suffix: 1 } as never,
    )).rejects.toMatchObject({ code: "EINVAL", path: "range-validation" });
  });

  it("removes an immutable R2 body with its filesystem entry", async () => {
    const stub = workspace("binary-delete");
    const written = await stub.putBinary("/assets/data.bin", new Uint8Array([1, 2, 3]).buffer, {
      createParents: true,
    });

    const removed = await execute(stub, {
      command: "rm",
      input: { path: "/assets/data.bin" },
    });
    expect(removed.exitCode).toBe(0);
    expect(await env.VFS_TEST_BUCKET.get(written.objectKey)).toBeNull();
    expect(await stub.drainBinaryGarbage()).toEqual({ deleted: 0, remaining: 0 });
  });

  it("queues an R2 destination before replacing it with an atomic move", async () => {
    const stub = workspace("move-replace-binary");
    const binary = await stub.putBinary("/target", new Uint8Array([1, 2, 3]).buffer);
    await execute(stub, {
      command: "write",
      input: { path: "/source", text: "replacement" },
    });

    const moved = await execute(stub, {
      command: "mv",
      input: { from: "/source", to: "/target", replace: true },
    });
    expect(moved.exitCode).toBe(0);
    expect(moved.data).toMatchObject({ replaced: true });
    expect((await execute(stub, { command: "cat", input: { path: "/target" } })).stdout)
      .toBe("replacement");

    expect(await stub.drainBinaryGarbage()).toEqual({ deleted: 1, remaining: 0 });
    expect(await env.VFS_TEST_BUCKET.get(binary.objectKey)).toBeNull();
  });

  it("appends SQLite chunks under a revision guard", async () => {
    const stub = workspace("append-text");
    const written = await execute(stub, {
      command: "write",
      input: { path: "/log", text: "hello" },
    });
    const revision = (written.data as { revision: number }).revision;

    const appended = await stub.appendText("/log", " world\nnext", { ifRevision: revision });
    expect(appended.revision).toBe(revision + 1);
    expect((await execute(stub, { command: "cat", input: { path: "/log" } })).stdout)
      .toBe("hello world\nnext");
  });

  it("touches text metadata without rewriting content", async () => {
    const stub = workspace("touch-text-metadata");
    const written = await execute(stub, {
      command: "write",
      input: { path: "/log", text: "hello world\nnext" },
    });
    const revision = (written.data as { revision: number }).revision;

    const touched = await stub.touchPath("/log", {
      ifRevision: revision,
      mode: 0o100600,
      modifiedAtMs: 1234,
    });
    expect(touched).toMatchObject({ mode: 0o100600, modifiedAtMs: 1234 });
    expect((await execute(stub, { command: "cat", input: { path: "/log" } })).stdout)
      .toBe("hello world\nnext");
  });

  it("touches binary metadata without replacing its immutable R2 body", async () => {
    const stub = workspace("touch-binary-metadata");
    const binary = await stub.putBinary("/asset", new Uint8Array([4, 5, 6]).buffer);
    const binaryTouched = await stub.touchPath("/asset", { modifiedAtMs: 5678 });
    expect(binaryTouched).toMatchObject({ sizeBytes: 3, modifiedAtMs: 5678, revision: 2 });
    expect([...new Uint8Array((await stub.readBinary("/asset")).bytes)]).toEqual([4, 5, 6]);
    expect(await env.VFS_TEST_BUCKET.get(binary.objectKey)).not.toBeNull();
  });

  it("persists requested directory modes in SQLite", async () => {
    const stub = workspace("directory-mode");
    const directory = await execute(stub, {
      command: "mkdir",
      input: { path: "/private", mode: 0o040700 },
    });
    expect((directory.data as { entries: Array<{ mode: number }> }).entries[0]?.mode).toBe(0o040700);
  });

  it("rejects oversized stdin at the RPC command boundary", async () => {
    const result = await execute(workspace("bounded-stdin"), {
      command: "ls",
      stdin: "가a",
      maxInputBytes: 3,
    });
    expect(result).toMatchObject({
      exitCode: 1,
      data: { code: "E2BIG", path: null },
    });
  });

  it("paginates namespace reads with SQL keyset cursors", async () => {
    const stub = workspace("pagination");
    for (const path of ["/page/a", "/page/b", "/page/c"]) {
      await execute(stub, {
        command: "write",
        input: { path, text: path, createParents: true },
      });
    }

    const first = await stub.listPage("/page", { limit: 2 });
    expect(first).toMatchObject({
      entries: [{ path: "/page/a" }, { path: "/page/b" }],
      nextCursor: "/page/b",
    });
    await execute(stub, {
      command: "write",
      input: { path: "/page/aa", text: "before cursor" },
    });
    const firstCursor = first.nextCursor;
    expect(firstCursor).not.toBeNull();
    if (firstCursor === null) throw new Error("first page must have a cursor");
    expect(await stub.listPage("/page", {
      limit: 2,
      cursor: firstCursor,
    })).toMatchObject({ entries: [{ path: "/page/c" }], nextCursor: null });
  });

  it("streams ranged R2 bodies over RPC", async () => {
    const stub = workspace("ranged-binary-stream");
    await stub.putBinary("/stream.bin", new Uint8Array([10, 20, 30, 40]).buffer);
    const streamed = await stub.readBinaryStream("/stream.bin", { offset: 1, length: 2 });
    expect(streamed.stat).toMatchObject({ path: "/stream.bin", sizeBytes: 4 });
    expect([...new Uint8Array(await new Response(streamed.stream).arrayBuffer())]).toEqual([20, 30]);
  });

  it("hashes and compares binary R2 bodies through streaming commands", async () => {
    const stub = workspace("binary-stream-commands");
    await stub.putBinary("/binary", new TextEncoder().encode("abc").buffer);
    await execute(stub, { command: "write", input: { path: "/text", text: "abc" } });

    expect(await execute(stub, { command: "sha256sum", input: { path: "/binary" } }))
      .toMatchObject({
        exitCode: 0,
        data: {
          entries: [{
            path: "/binary",
            digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            sizeBytes: 3,
          }],
        },
      });
    expect(await execute(stub, {
      command: "cmp",
      input: { from: "/binary", to: "/text" },
    })).toMatchObject({ exitCode: 0, data: { equal: true, bytesCompared: 3 } });
  });

  it("supports cancelling an R2 body stream", async () => {
    const stub = workspace("cancel-binary-stream");
    await stub.putBinary("/stream.bin", new Uint8Array([10, 20, 30, 40]).buffer);
    const cancellable = await stub.readBinaryStream("/stream.bin");
    await cancellable.stream.cancel("consumer stopped");
  });
});

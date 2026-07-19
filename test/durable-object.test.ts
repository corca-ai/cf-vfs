import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ExecuteRequest, ExecuteResult } from "../src/core/command.js";
import type { TestWorkspaceVfs } from "./worker.js";

function workspace(name: string): DurableObjectStub<TestWorkspaceVfs> {
  const namespace = env.VFS_TEST as DurableObjectNamespace<TestWorkspaceVfs>;
  return namespace.getByName(name);
}

async function execute(
  stub: DurableObjectStub<TestWorkspaceVfs>,
  request: ExecuteRequest,
): Promise<ExecuteResult> {
  return stub.execute(request);
}

describe("SQLite Durable Object filesystem", () => {
  it("stores chunked text as one file and supports metadata-first commands", async () => {
    const stub = workspace("text-commands");
    const text = `${"alpha 123\n".repeat(400)}omega 999\n`;
    const write = await execute(stub, {
      command: "write",
      input: { path: "/repo/logs/app.log", text, createParents: true },
    });
    expect(write.exitCode).toBe(0);

    const stat = await execute(stub, { command: "stat", input: { path: "/repo/logs/app.log" } });
    expect(stat.stdout).toContain(`Size: ${new TextEncoder().encode(text).byteLength}`);

    const grep = await execute(stub, {
      command: "grep",
      input: { pattern: "omega\\s+\\d+", paths: ["/repo"] },
    });
    expect(grep.stdout).toContain("/repo/logs/app.log:401:1:omega 999");

    const tail = await execute(stub, {
      command: "tail",
      input: { path: "/repo/logs/app.log", lines: 1 },
    });
    expect(tail.stdout).toBe("omega 999\n");

    const move = await execute(stub, {
      command: "mv",
      input: { from: "/repo/logs", to: "/repo/archive" },
    });
    expect(move.exitCode).toBe(0);
    expect((await execute(stub, {
      command: "cat",
      input: { path: "/repo/archive/app.log" },
    })).stdout).toBe(text);
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

    const removed = await execute(stub, {
      command: "rm",
      input: { path: "/assets/data.bin" },
    });
    expect(removed.exitCode).toBe(0);
    expect(await env.VFS_TEST_BUCKET.get(written.objectKey)).toBeNull();
    expect(await stub.drainBinaryGarbage()).toEqual({ deleted: 0, remaining: 0 });
  });
});

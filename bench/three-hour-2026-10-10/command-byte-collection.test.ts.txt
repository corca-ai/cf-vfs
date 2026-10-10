import { expect, it } from "vitest";
import { collectStream } from "../src/shell/commands/helpers.js";
import { Shell } from "../src/shell/shell.js";
import { defineTestApplet } from "./helpers/applet.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

it("retains one private input chunk without needing a second body-sized budget", async () => {
  const original = new Uint8Array(64 * 1024).fill(7);
  const command = defineTestApplet("probe", async (context) => {
    const available = context.budget.remainingBufferedBytes?.();
    const lease = await collectStream(
      context,
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(original);
          controller.close();
        },
      }),
    );
    original.fill(9);
    expect(lease.value).toHaveLength(64 * 1024);
    expect(lease.value.every((byte) => byte === 7)).toBe(true);
    lease.release();
    expect(context.budget.remainingBufferedBytes?.()).toBe(available);
    return 0;
  });
  const shell = new Shell({
    fileSystem: createTestFileSystem(),
    commands: [command],
    limits: { maxBufferedBytes: 96 * 1024 },
  });
  const result = await shell.executeText({ script: "probe" });
  expect(result.exitCode, result.stderr).toBe(0);
});

it("checks the deadline and releases its lease when EOF arrives after the deadline", async () => {
  let now = 0;
  const command = defineTestApplet("probe", async (context) => {
    const available = context.budget.remainingBufferedBytes?.();
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulls++ === 0) controller.enqueue(Uint8Array.of(7));
          else {
            now = 20;
            controller.close();
          }
        },
      },
      { highWaterMark: 0 },
    );
    await expect(collectStream(context, source)).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(context.budget.remainingBufferedBytes?.()).toBe(available);
    now = 0;
    return 0;
  });
  const shell = new Shell({
    fileSystem: createTestFileSystem(),
    commands: [command],
    now: () => now,
    limits: { deadlineMs: 10 },
  });
  const result = await shell.executeText({ script: "probe" });
  expect(result.exitCode, result.stderr).toBe(0);
});

import { expect, it } from "vitest";
import { WorkspaceOperations } from "../demo/workspace-operations.js";

it("serializes two callers, survives a failed command and bounds admission", async () => {
  const operations = new WorkspaceOperations(2);
  const events: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = operations.run(async () => {
    events.push("first");
    await gate;
    throw new Error("failed");
  });
  const failed = expect(first).rejects.toThrow("failed");
  const second = operations.run(() => {
    events.push("second");
    return 2;
  });
  await expect(operations.run(() => events.push("overflow"))).rejects.toMatchObject({
    code: "EAGAIN",
  });
  expect(events).toEqual(["first"]);
  release();
  await failed;
  expect(await second).toBe(2);
  expect(await operations.run(() => 3)).toBe(3);
  expect(events).toEqual(["first", "second"]);
});

import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { AgentTask } from "./benchmark-agent-task.js";

export async function createTaskFixture(storage: DurableObjectStorage) {
  const fs = new DurableObjectFileSystem(storage, {
    workspaceId: "agent-task",
    maxEntries: 20_000,
    maxInlineLogicalBytes: 32 * 1024 * 1024,
  });
  await fs.initialize();
  const task = new AgentTask(fs);
  await task.prepare();
  // Distinct content warms the actual status/edit/add/commit chain.
  await task.cycle();
  await task.cycle();
  return task;
}

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { awkCommand } from "../src/shell/commands/awk.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { Shell } from "../src/shell/shell.js";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import type { TestWorkspaceVfs } from "../test/worker.js";
import { meterSqlStorage } from "./metered-sql.js";
import workloads from "./text-processing-cases.json";

it.each(workloads)("text processing: $name", async (workload) => {
  const stub: DurableObjectStub<TestWorkspaceVfs> = env.VFS_TEST.getByName(workload.name);
  const metrics = await runInDurableObject(stub, async (_instance, state) => {
    const meter = meterSqlStorage(state.storage);
    const fs = new DurableObjectFileSystem(meter.storage);
    await fs.writeFile("/input", workload.input.repeat(workload.repeat));
    const shell = new Shell({
      fileSystem: fs,
      commands: [...defaultShellCommands, awkCommand],
      limits: { maxSteps: 1_000_000 },
    });
    const expected = workload.output.repeat(workload.outputRepeat);
    const execute = async () => {
      meter.reset();
      const result = await shell.executeText({ script: workload.script });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toBe(expected);
      expect(meter.statements).toBe(2);
      expect(meter.rowsRead).toBe(2);
      expect(meter.rowsWritten).toBe(0);
    };
    for (let index = 0; index < 3; index += 1) await execute();
    const durations: number[] = [];
    for (let sample = 0; sample < 11; sample += 1) {
      const start = performance.now();
      for (let repeat = 0; repeat < 3; repeat += 1) await execute();
      durations.push((performance.now() - start) / 3);
    }
    durations.sort((a, b) => a - b);
    return {
      name: workload.name,
      medianMs: durations[5],
      p10Ms: durations[1],
      p90Ms: durations[9],
      statements: meter.statements,
      rowsRead: meter.rowsRead,
      rowsWritten: meter.rowsWritten,
    };
  });
  console.log("text processing workerd:", JSON.stringify(metrics));
});

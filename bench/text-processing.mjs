import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import workloads from "./text-processing-cases.json" with { type: "json" };

// An optional compiled module root permits the same workloads against a saved
// baseline without changing branches or sharing module state between versions.
const root = process.argv[2]
  ? pathToFileURL(`${resolve(process.argv[2])}/`)
  : new URL("../dist/", import.meta.url);
const { Shell } = await import(new URL("shell/shell.js", root));
const { NodeSqlFileSystem } = await import(new URL("testing/node.js", root));
const { defaultShellCommands } = await import(new URL("shell/commands/default.js", root));
const { awkCommand } = await import(new URL("shell/commands/awk.js", root));
const { utf8ByteLength } = await import(new URL("core/unicode.js", root));
const rows = [];

async function measure(name, operation) {
  for (let index = 0; index < 3; index += 1) await operation();
  const durations = [];
  let result;
  for (let index = 0; index < 11; index += 1) {
    const started = performance.now();
    result = await operation();
    durations.push(performance.now() - started);
  }
  durations.sort((a, b) => a - b);
  rows.push({ name, medianMs: durations[5], p10Ms: durations[1], p90Ms: durations[9], ...result });
}

let statements = 0;
let returnedRows = 0;
const fs = new NodeSqlFileSystem({
  onStatement: (_sql, count) => {
    statements += 1;
    returnedRows += count;
  },
});
const shell = new Shell({
  fileSystem: fs,
  commands: [...defaultShellCommands, awkCommand],
  limits: { maxSteps: 1_000_000 },
});

try {
  for (const workload of workloads) {
    const { name, script } = workload;
    await fs.writeFile("/input", workload.input.repeat(workload.repeat));
    const stdout = workload.output.repeat(workload.outputRepeat);
    await measure(name, async () => {
      statements = 0;
      returnedRows = 0;
      const result = await shell.executeText({ script });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, stdout);
      return { outputBytes: Buffer.byteLength(stdout), statements, returnedRows };
    });
  }
  for (const [name, value, repeats] of [
    ["utf8-ascii-short", "const value = 123;", 100_000],
    ["utf8-ascii-8k", "x".repeat(8192), 10_000],
    ["utf8-unicode-8k", "한글😀".repeat(819), 10_000],
  ]) {
    const expected = Buffer.byteLength(value) * repeats;
    await measure(name, () => {
      let bytes = 0;
      for (let index = 0; index < repeats; index += 1) bytes += utf8ByteLength(value);
      assert.equal(bytes, expected);
      return { bytes, repeats };
    });
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        warmups: 3,
        samples: 11,
        rows,
      },
      null,
      2,
    ),
  );
} finally {
  fs.close();
}

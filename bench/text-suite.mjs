import assert from "node:assert/strict";
import workloads from "./text-processing-cases.json" with { type: "json" };

export const unicodeWorkloads = [
  { name: "utf8-ascii-short", value: "const value = 123;", repeats: 100_000 },
  { name: "utf8-ascii-8k", value: "x".repeat(8192), repeats: 10_000 },
  { name: "utf8-unicode-8k", value: "한글😀".repeat(819), repeats: 10_000 },
];
export const workloadNames = [...workloads, ...unicodeWorkloads].map(({ name }) => name);

export async function createTextSuite(root) {
  const { Shell } = await import(new URL("shell/shell.js", root));
  const { NodeSqlFileSystem } = await import(new URL("testing/node.js", root));
  const { defaultShellCommands } = await import(new URL("shell/commands/default.js", root));
  const { awkCommand } = await import(new URL("shell/commands/awk.js", root));
  const { utf8ByteLength } = await import(new URL("core/unicode.js", root));
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
  return {
    async prepare(name) {
      const workload = workloads.find((workload) => workload.name === name);
      if (workload) await fs.writeFile("/input", workload.input.repeat(workload.repeat));
    },
    async run(name) {
      const workload = workloads.find((workload) => workload.name === name);
      if (workload) {
        statements = 0;
        returnedRows = 0;
        const result = await shell.executeText({ script: workload.script });
        const stdout = workload.output.repeat(workload.outputRepeat);
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(result.stdout, stdout);
        return { outputBytes: Buffer.byteLength(stdout), statements, returnedRows };
      }
      const unicode = unicodeWorkloads.find((workload) => workload.name === name);
      assert.ok(unicode, `unknown workload: ${name}`);
      let bytes = 0;
      for (let index = 0; index < unicode.repeats; index += 1)
        bytes += utf8ByteLength(unicode.value);
      assert.equal(bytes, Buffer.byteLength(unicode.value) * unicode.repeats);
      return { bytes, repeats: unicode.repeats };
    },
    close: () => fs.close(),
  };
}

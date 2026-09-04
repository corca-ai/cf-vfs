import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = new URL("../dist/", import.meta.url);
const setup = `
import { NodeSqlFileSystem } from ${JSON.stringify(new URL("testing/node.js", root).href)};
import { Shell } from ${JSON.stringify(new URL("shell/shell.js", root).href)};
import { defaultShellCommands } from ${JSON.stringify(new URL("shell/commands/default.js", root).href)};
import { awkCommand } from ${JSON.stringify(new URL("shell/commands/awk.js", root).href)};
const fs = new NodeSqlFileSystem();
`;
const cases = [
  {
    name: "sed discarded pattern-space amplification",
    script: `sed -n 's/.*/${"&".repeat(20)}/;d' /input`,
    prepare: "await fs.writeFile('/input', 'x'.repeat(100));",
    limits: { maxExpansionChars: 1024 },
  },
  {
    name: "awk rebuilt record bytes",
    script: 'awk \'BEGIN { OFS=sprintf("%0600d",1); $5="x"; print "done" }\'',
    limits: { maxExpansionChars: 10000, maxBufferedBytes: 1024 },
  },
  {
    name: "awk scalar growth",
    script: "awk 'BEGIN { x=\"x\"; for(i=0;i<20;i++) x=x x; print length(x) }'",
    limits: { maxExpansionChars: 1024, maxBufferedBytes: 1024 },
  },
  {
    name: "glob backtracking",
    script: `find / -name '${"*a".repeat(12)}b'`,
    prepare: `await fs.writeFile('/' + 'a'.repeat(100), '');`,
    success: true,
  },
  { name: "jq discarded work", script: "jq -n 'range(0;1000000000) | empty'" },
  {
    name: "jq intermediate records",
    script: "jq -n '[range(0;100001)] | length'",
    limits: { maxBufferedRecords: 10 },
  },
  {
    name: "jq intermediate bytes",
    script: "jq -n '\"x\" * 1000000000 | length'",
    limits: { maxBufferedBytes: 1000 },
  },
  {
    name: "jq builtin intermediate array",
    script: `jq -n '"${"a,".repeat(100)}" | split(",") | length'`,
    limits: { maxBufferedRecords: 10 },
  },
  {
    name: "jq joined string amplification",
    script: "jq -n '[range(0;10000)] | join(\"x\" * 10000) | length'",
    limits: { maxBufferedBytes: 1_000_000 },
  },
  {
    name: "jq shared array serialization",
    script: `jq -n '${Array(40).fill("[.,.]").join(" | ")}'`,
  },
  {
    name: "jq shared array flattening",
    script: `jq -n '${Array(40).fill("[.,.]").join(" | ")} | flatten | length'`,
  },
  {
    name: "jq parsed records",
    prepare: "await fs.writeFile('/input', JSON.stringify(Array(1000).fill(0)));",
    script: "jq length /input",
    limits: { maxBufferedRecords: 10 },
  },
];
for (const test of cases) {
  // A native matcher or synchronous evaluator can block the event loop, so an
  // in-process timeout cannot make this regression test safe.
  const { stdout } = await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `${setup}
${test.prepare ?? ""}
const shell = new Shell({ fileSystem: fs, commands: [...defaultShellCommands, awkCommand], limits: ${JSON.stringify({ deadlineMs: test.success ? 1000 : 50, ...test.limits })} });
try { console.log(JSON.stringify(await shell.executeText({ script: ${JSON.stringify(test.script)} }))); }
finally { fs.close(); }
`,
    ],
    { timeout: 5000 },
  );
  const result = JSON.parse(stdout);
  if (test.success) assert.equal(result.exitCode, 0, test.name);
  else {
    assert.notEqual(result.exitCode, 0, test.name);
    assert.match(result.stderr, /limit|deadline/, test.name);
  }
}
// Invalid chunk sizes used to loop synchronously. Keep that regression outside
// the test runner so its event loop cannot prevent the watchdog from firing.
await run(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `
import assert from 'node:assert/strict';
import { rechunk, collectRechunkedBytes } from ${JSON.stringify(new URL("vfs/index.js", root).href)};
for (const size of [0, -1, 0.5, NaN, Infinity]) {
  assert.throws(() => rechunk([new Uint8Array([1])], size), { code: 'EINVAL' });
  await assert.rejects(collectRechunkedBytes(new Uint8Array([1]), 10, size), { code: 'EINVAL' });
}
`,
  ],
  { timeout: 5000 },
);
console.log(`execution limits verified in ${cases.length + 1} isolated processes`);

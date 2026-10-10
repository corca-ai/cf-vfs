import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const [dist, output] = process.argv.slice(2);
const directory = "/tmp/cf-vfs-add-profile-20261009";
await mkdir(directory, { recursive: true });
await cp(dist, `${directory}/dist`, { recursive: true });
await writeFile(`${directory}/package.json`, '{"type":"module"}');
const modulePath = `${directory}/dist/shell/commands/git-worktree.js`;
let source = await readFile(modulePath, "utf8");
const matrixStatement = source.match(/const matrix = await gitMatrix\([^;]+\);/u)?.[0];
assert(matrixStatement);
source = source.replace(
  matrixStatement,
  `const phaseStart = globalThis.__gitAddSnapshot();\n    ${matrixStatement}\n    globalThis.__gitAddRecord("inspection", phaseStart);\n    const stageStart = globalThis.__gitAddSnapshot();`,
);
const addEnd = source.indexOf("\n}\n", source.indexOf("export async function gitAdd"));
assert(addEnd > 0);
source = `${source.slice(0, addEnd)}\n    globalThis.__gitAddRecord("staging", stageStart);${source.slice(addEnd)}`;
await writeFile(modulePath, source);
const root = pathToFileURL(`${directory}/dist/`);
const { NodeSqlFileSystem } = await import(new URL("testing/node.js", root));
const { Shell } = await import(new URL("shell/shell.js", root));
const { gitCommand } = await import(new URL("shell/commands/git.js", root));
const rows = [];
for (let trial = -2; trial < 5; trial++) {
  let sql = 0,
    reads = 0,
    indexWrites = 0,
    indexBytes = 0;
  const phases = [];
  const vfs = new NodeSqlFileSystem({ onStatement: () => sql++ });
  const read = vfs.readFile.bind(vfs);
  vfs.readFile = (...args) => {
    reads++;
    return read(...args);
  };
  const write = vfs.writeFile.bind(vfs);
  vfs.writeFile = (path, body, ...rest) => {
    if (path === "/repo/.git/index") {
      indexWrites++;
      indexBytes += body.byteLength ?? body.length;
    }
    return write(path, body, ...rest);
  };
  globalThis.__gitAddSnapshot = () => ({
    at: performance.now(),
    sql,
    reads,
    indexWrites,
    indexBytes,
  });
  globalThis.__gitAddRecord = (phase, before) => {
    const after = globalThis.__gitAddSnapshot();
    phases.push({
      phase,
      ms: after.at - before.at,
      sql: after.sql - before.sql,
      reads: after.reads - before.reads,
      indexWrites: after.indexWrites - before.indexWrites,
      indexBytes: after.indexBytes - before.indexBytes,
    });
  };
  const shell = new Shell({ fileSystem: vfs, commands: [gitCommand] });
  assert.equal((await shell.executeText({ script: "git init /repo" })).exitCode, 0);
  for (let n = 0; n < 1000; n++) await vfs.writeFile(`/repo/f${n}`, `file ${n}\n`.repeat(80));
  const result = await shell.executeText({ cwd: "/repo", script: "git add -A" });
  assert.equal(result.exitCode, 0, result.stderr);
  if (trial >= 0) rows.push({ trial, phases });
  vfs.close();
}
await writeFile(
  output,
  `${JSON.stringify(
    {
      node: process.version,
      instrumentation: "temporary compiled module phase timers; SQL/read/index-write counters",
      files: 1000,
      rows,
    },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify(rows, null, 2));

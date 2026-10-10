import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import git from "isomorphic-git";

export async function runTrial(root, trial, files = 1000) {
  const { createFsAdapter } = await import(new URL("fs/index.js", root));
  const { gitCommand } = await import(new URL("shell/commands/git.js", root));
  const { Shell } = await import(new URL("shell/shell.js", root));
  const { NodeSqlFileSystem } = await import(new URL("testing/node.js", root));
  const rows = [];
  let calls = 0,
    reads = 0;
  const vfs = new NodeSqlFileSystem({ onStatement: () => calls++ });
  const originalRead = vfs.readFile.bind(vfs);
  vfs.readFile = (...args) => {
    reads++;
    return originalRead(...args);
  };
  const fs = createFsAdapter(vfs);
  const shell = new Shell({
    fileSystem: vfs,
    commands: [gitCommand],
    limits: { maxTotalIoBytes: 1024 * 1024 * 1024, maxMutations: 100_000 },
  });
  vfs.mkdir("/repo");
  await git.init({ fs, dir: "/repo", defaultBranch: "main" });
  for (let i = 0; i < files; i++) await vfs.writeFile(`/repo/f${i}`, `file ${i}\n`.repeat(80));
  async function measure(operation, script) {
    calls = 0;
    reads = 0;
    const start = performance.now();
    const result = await shell.executeText({ cwd: "/repo", script });
    const ms = performance.now() - start;
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    if (trial >= 0) rows.push({ trial, operation, ms, calls, reads });
  }
  await measure("add-all", "git add -A");
  await git.commit({
    fs,
    dir: "/repo",
    message: "initial",
    author: { name: "test", email: "test@example.invalid" },
  });
  await measure("add-unchanged", "git add -A");
  await vfs.writeFile("/repo/f0", "changed\n");
  await measure("add-one", "git add f0");
  vfs.remove("/repo/f0");
  await measure("remove-one", "git add f0");
  assert.equal((await git.statusMatrix({ fs, dir: "/repo" })).find((row) => row[0] === "f0")[3], 0);
  for (let i = 1; i < files; i++) vfs.remove(`/repo/f${i}`);
  await measure("remove-all", "git add -A");
  assert.equal((await git.listFiles({ fs, dir: "/repo" })).length, 0);
  vfs.close();
  return rows;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rows = [];
  for (let trial = -1; trial < 5; trial++)
    rows.push(...(await runTrial(new URL("../../dist/", import.meta.url), trial)));
  await writeFile(process.argv[2] ?? "/tmp/git-shell.json", JSON.stringify({ rows }, null, 2));
  for (const operation of [...new Set(rows.map((row) => row.operation))]) {
    const selected = rows.filter((row) => row.operation === operation);
    console.log(
      operation,
      JSON.stringify({
        medianMs: selected.map((row) => row.ms).sort((a, b) => a - b)[2],
        calls: selected[0].calls,
        reads: selected[0].reads,
      }),
    );
  }
}

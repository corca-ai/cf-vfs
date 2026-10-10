import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import git from "isomorphic-git";

const [before, after, output] = process.argv.slice(2);
const rows = [];
for (const [version, path] of [
  ["baseline", before],
  ["candidate", after],
]) {
  const root = pathToFileURL(`${resolve(path)}/`);
  const { NodeSqlFileSystem } = await import(new URL("testing/node.js", root));
  const { createFsAdapter } = await import(new URL("fs/index.js", root));
  const { Shell } = await import(new URL("shell/shell.js", root));
  const { gitCommand } = await import(new URL("shell/commands/git.js", root));
  const vfs = new NodeSqlFileSystem();
  const fs = createFsAdapter(vfs);
  vfs.mkdir("/repo");
  await git.init({ fs, dir: "/repo", defaultBranch: "main" });
  for (let i = 0; i < 200; i++) await vfs.writeFile(`/repo/f${i}`, "tracked\n".repeat(96));
  const shell = new Shell({ fileSystem: vfs, commands: [gitCommand] });
  assert.equal((await shell.executeText({ cwd: "/repo", script: "git add -A" })).exitCode, 0);
  await git.commit({
    fs,
    dir: "/repo",
    message: "initial",
    author: { name: "test", email: "test@example.invalid" },
  });
  const limits = [];
  const bounded = new Shell({
    fileSystem: vfs,
    commands: [gitCommand],
    limits: { maxBufferedBytes: 32768 },
    onEvent: (event) => {
      if (event.type === "shell.limit") limits.push(event.limit);
    },
  });
  const result = await bounded.executeText({ cwd: "/repo", script: "git add -A" });
  rows.push({ version, files: 200, maxBufferedBytes: 32768, ...result, limits });
  vfs.close();
}
await writeFile(output, `${JSON.stringify({ rows }, null, 2)}\n`);
console.log(JSON.stringify(rows, null, 2));

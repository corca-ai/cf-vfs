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
  let sql = 0,
    indexWrites = 0,
    indexBytes = 0;
  const vfs = new NodeSqlFileSystem({ onStatement: () => sql++ });
  const fs = createFsAdapter(vfs);
  const write = vfs.writeFile.bind(vfs);
  vfs.writeFile = (path, body, ...args) => {
    if (path === "/repo/.git/index") {
      indexWrites++;
      indexBytes += body.byteLength;
    }
    return write(path, body, ...args);
  };
  vfs.mkdir("/repo");
  await git.init({ fs, dir: "/repo", defaultBranch: "main" });
  for (let i = 0; i < 1000; i++) await vfs.writeFile(`/repo/f${i}`, `file ${i}\n`);
  const shell = new Shell({ fileSystem: vfs, commands: [gitCommand] });
  assert.equal((await shell.executeText({ cwd: "/repo", script: "git add -A" })).exitCode, 0);
  await git.commit({
    fs,
    dir: "/repo",
    message: "initial",
    author: { name: "test", email: "test@example.invalid" },
  });
  for (let i = 0; i < 1000; i++) vfs.remove(`/repo/f${i}`);
  sql = indexWrites = indexBytes = 0;
  const start = performance.now();
  const result = await shell.executeText({ cwd: "/repo", script: "git add -A" });
  const ms = performance.now() - start;
  assert.equal(result.exitCode, 0, result.stderr);
  rows.push({ version, files: 1000, ms, sql, indexWrites, indexBytes });
  assert.equal((await git.listFiles({ fs, dir: "/repo" })).length, 0);
  assert.equal((await git.listFiles({ fs, dir: "/repo", ref: "HEAD" })).length, 1000);
  vfs.close();
}
await writeFile(output, `${JSON.stringify({ node: process.version, rows }, null, 2)}\n`);
console.log(JSON.stringify(rows, null, 2));

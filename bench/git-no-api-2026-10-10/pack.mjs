import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as git from "isomorphic-git";
import { distribution, pairedRatio, pairOrder } from "../comparison.mjs";

const root = pathToFileURL(`${resolve(process.argv[2])}/`);
const { NodeSqlFileSystem } = await import(new URL("testing/node.js", root));
const { Shell } = await import(new URL("shell/shell.js", root));
const { gitCommand } = await import(new URL("shell/commands/git.js", root));
const { createFsAdapter } = await import(new URL("fs/index.js", root));
const rows = [];
for (let pair = -2; pair < 8; pair++)
  for (const version of pairOrder(pair)) {
    const vfs = new NodeSqlFileSystem();
    const shell = new Shell({ fileSystem: vfs, commands: [gitCommand] });
    const run = async (script) => {
      const r = await shell.executeText({ script, cwd: "/repo" });
      assert.equal(r.exitCode, 0, r.stderr);
      return r;
    };
    try {
      await shell.executeText({ script: "git init /repo" });
      for (let generation = 0; generation < 2; generation++) {
        for (let i = 0; i < 1000; i++) {
          let seed = i + generation * 1000 + 1;
          const b = Uint8Array.from({ length: 768 }, () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return 32 + ((seed >>> 24) % 95);
          });
          await vfs.writeFile(`/repo/f${i}`, b);
        }
        if (generation === 0)
          await run("git config user.name Bench; git config user.email bench@example.invalid");
        await run(`git add -A; git commit -m generation${generation}`);
        if (generation === 0) await run("git branch base");
      }
      const beforeSize = vfs.storage.sql.databaseSize;
      let packingMs = 0,
        packBytes = 0;
      if (version === "candidate") {
        const start = performance.now();
        const fs = createFsAdapter(vfs);
        const oids = [];
        const dirs = vfs.list("/repo/.git/objects").filter((e) => /^[a-f0-9]{2}$/.test(e.name));
        for (const dir of dirs) for (const f of vfs.list(dir.path)) oids.push(dir.name + f.name);
        const { filename } = await git.packObjects({ fs, dir: "/repo", oids, write: true });
        await git.indexPack({ fs, dir: "/repo", filepath: `.git/objects/pack/${filename}` });
        for (const dir of dirs) await vfs.remove(dir.path, { recursive: true });
        packBytes = vfs.stat(`/repo/.git/objects/pack/${filename}`).sizeBytes;
        packingMs = performance.now() - start;
        for (const oid of oids) await git.readObject({ fs, dir: "/repo", oid });
      }
      const afterSize = vfs.storage.sql.databaseSize;
      const start = performance.now();
      await run("git clone /repo /copy");
      const ms = performance.now() - start;
      assert.equal(
        (await shell.executeText({ script: "git status --porcelain", cwd: "/copy" })).stdout,
        "",
      );
      const t = performance.now();
      await shell
        .executeText({ script: "git checkout base", cwd: "/copy" })
        .then((r) => assert.equal(r.exitCode, 0, r.stderr));
      const checkoutMs = performance.now() - t;
      if (pair >= 0)
        rows.push({ pair, version, ms, checkoutMs, packingMs, packBytes, beforeSize, afterSize });
    } finally {
      vfs.close();
    }
  }
const summary = {};
for (const key of ["ms", "checkoutMs", "packingMs", "packBytes", "beforeSize", "afterSize"]) {
  const a = rows.filter((r) => r.version === "baseline").map((r) => r[key]),
    b = rows.filter((r) => r.version === "candidate").map((r) => r[key]);
  summary[key] = {
    before: a.every((x) => x > 0) ? distribution(a) : { median: 0 },
    after: b.every((x) => x > 0) ? distribution(b) : { median: 0 },
    ...(a.every((x) => x > 0) && b.every((x) => x > 0) ? { ratio: pairedRatio(a, b) } : {}),
  };
}
await writeFile(process.argv[3], JSON.stringify({ summary, rows }, null, 2) + "\n");
console.log(JSON.stringify(summary));

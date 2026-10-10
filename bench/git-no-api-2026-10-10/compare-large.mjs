import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { distribution, pairedRatio, pairOrder } from "../comparison.mjs";

const [before, after, out] = process.argv.slice(2);
const profile = process.env.PROFILE === "1";
const rows = [];
for (let pair = -2; pair < 4; pair++)
  for (const version of pairOrder(pair)) {
    const root = pathToFileURL(`${resolve(version === "baseline" ? before : after)}/`);
    const { NodeSqlFileSystem } = await import(new URL("testing/node.js", root));
    const { Shell } = await import(new URL("shell/shell.js", root));
    const { gitCommand } = await import(new URL("shell/commands/git.js", root));
    let sql = 0,
      reads = 0;
    const vfs = new NodeSqlFileSystem(profile ? { onStatement: () => sql++ } : {});
    if (profile) {
      const read = vfs.readFile.bind(vfs);
      vfs.readFile = (...args) => {
        reads++;
        return read(...args);
      };
    }
    const shell = new Shell({
      fileSystem: vfs,
      commands: [gitCommand],
      limits: {
        maxTotalIoBytes: 256 * 1024 * 1024,
        maxGlobMatches: 100000,
        maxSteps: 1000000,
        maxMutations: 100000,
      },
      policy: { maxMutations: 100000 },
    });
    const run = async (script) => {
      const r = await shell.executeText({ script, cwd: "/repo" });
      assert.equal(r.exitCode, 0, r.stderr);
      return r;
    };
    try {
      await shell.executeText({ script: "git init /repo" });
      for (let i = 0; i < 5000; i++) await vfs.writeFile(`/repo/f${i}`, `body ${i} `.repeat(96));
      await run(
        "git config user.name Bench && git config user.email bench@example.invalid && git add -A && git commit -m base && git branch base",
      );
      for (const [name, script] of [
        ["status-first", "git status --porcelain"],
        ["status-repeat", "git status --porcelain"],
        ["add-clean", "git add -A"],
      ]) {
        sql = 0;
        reads = 0;
        const start = performance.now();
        const r = await run(script);
        const ms = performance.now() - start;
        if (name.startsWith("status")) assert.equal(r.stdout, "");
        if (pair >= 0) rows.push({ pair, version, name, ms, ...(profile ? { sql, reads } : {}) });
      }
      await vfs.writeFile("/repo/f7", "new7 ".repeat(96));
      for (const [name, script] of [
        ["status-one", "git status --porcelain"],
        ["add-one", "git add -A"],
      ]) {
        sql = 0;
        reads = 0;
        const start = performance.now();
        const r = await run(script);
        const ms = performance.now() - start;
        if (name === "status-one") assert.match(r.stdout, / M "f7"/);
        if (pair >= 0) rows.push({ pair, version, name, ms, ...(profile ? { sql, reads } : {}) });
      }
      await run("git commit -m next");
      for (let i = 0; i < 5000; i++) await vfs.writeFile(`/repo/f${i}`, `changed ${i} `.repeat(96));
      sql = 0;
      reads = 0;
      let started = performance.now();
      await run("git add -A");
      let elapsed = performance.now() - started;
      if (pair >= 0)
        rows.push({
          pair,
          version,
          name: "add-all",
          ms: elapsed,
          ...(profile ? { sql, reads } : {}),
        });
      await run("git commit -m all");
      sql = 0;
      reads = 0;
      started = performance.now();
      await run("git checkout base");
      elapsed = performance.now() - started;
      if (pair >= 0)
        rows.push({
          pair,
          version,
          name: "checkout-all",
          ms: elapsed,
          ...(profile ? { sql, reads } : {}),
        });

      assert.equal((await run("git status --porcelain")).stdout, "");
    } finally {
      vfs.close();
    }
  }
const summary = {};
for (const name of new Set(rows.map((r) => r.name))) {
  const a = rows.filter((r) => r.name === name && r.version === "baseline"),
    b = rows.filter((r) => r.name === name && r.version === "candidate");
  summary[name] = {
    before: distribution(a.map((r) => r.ms)),
    after: distribution(b.map((r) => r.ms)),
    ratio: pairedRatio(
      a.map((r) => r.ms),
      b.map((r) => r.ms),
    ),
  };
}
await writeFile(out, JSON.stringify({ profile, summary, rows }, null, 2) + "\n");
console.log(JSON.stringify(summary));

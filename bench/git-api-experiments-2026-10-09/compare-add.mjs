import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import git from "isomorphic-git";
import { distribution, pairedRatio, pairOrder } from "../comparison.mjs";

const profiling = process.env.PROFILE_ADD === "1";
const [before, after, out] = process.argv.slice(2),
  rows = [];
async function trial(version, rootPath, n) {
  const root = pathToFileURL(`${resolve(rootPath)}/`);
  const { NodeSqlFileSystem } = await import(new URL("testing/node.js", root));
  const { createFsAdapter } = await import(new URL("fs/index.js", root));
  const { Shell } = await import(new URL("shell/shell.js", root));
  const { gitCommand } = await import(new URL("shell/commands/git.js", root));
  let reads = 0,
    calls = 0;
  const vfs = new NodeSqlFileSystem({ onStatement: () => calls++ });
  const read = vfs.readFile.bind(vfs);
  vfs.readFile = (...args) => {
    reads++;
    return read(...args);
  };
  const writes = {
    indexWrites: 0,
    indexBytes: 0,
    batchCalls: 0,
    objectWriteAttempts: 0,
    batchSizes: [],
  };
  if (profiling) {
    const writeOne = vfs.writeFile.bind(vfs),
      writeSet = vfs.writeFiles.bind(vfs);
    vfs.writeFile = (path, body, options) => {
      if (path === "/repo/.git/index") {
        writes.indexWrites++;
        writes.indexBytes += body.byteLength;
      }
      if (path.startsWith("/repo/.git/objects/")) writes.objectWriteAttempts++;
      return writeOne(path, body, options);
    };
    vfs.writeFiles = (entries, options) => {
      writes.batchCalls++;
      writes.batchSizes.push(entries.length);
      writes.objectWriteAttempts += entries.filter((entry) =>
        entry.path.startsWith("/repo/.git/objects/"),
      ).length;
      return writeSet(entries, options);
    };
  }
  const fs = createFsAdapter(vfs),
    shell = new Shell({
      fileSystem: vfs,
      commands: [gitCommand],
      limits: { maxTotalIoBytes: 128 * 1024 * 1024 },
    });
  vfs.mkdir("/repo");
  await git.init({ fs, dir: "/repo", defaultBranch: "main" });
  for (let i = 0; i < 1000; i++) await vfs.writeFile(`/repo/f${i}`, `file ${i} old\n`.repeat(48));
  if (process.env.ADD_MODE !== "initial") {
    assert.equal((await shell.executeText({ cwd: "/repo", script: "git add -A" })).exitCode, 0);
    await git.commit({
      fs,
      dir: "/repo",
      message: "initial",
      author: { name: "test", email: "test@example.invalid" },
    });
    if (process.env.ADD_MODE !== "unchanged")
      for (let i = 0; i < (process.env.ADD_MODE === "one" ? 1 : 1000); i++)
        await vfs.writeFile(`/repo/f${i}`, `file ${i} new\n`.repeat(48));
  }
  reads = calls = 0;
  writes.indexWrites = writes.indexBytes = writes.batchCalls = writes.objectWriteAttempts = 0;
  writes.batchSizes.length = 0;
  const start = performance.now();
  const result = await shell.executeText({
    cwd: "/repo",
    script: process.env.ADD_MODE === "one" ? "git add f0" : "git add -A",
  });
  const ms = performance.now() - start;
  assert.equal(result.exitCode, 0, result.stderr);
  const measured = { reads, calls, ...(profiling ? writes : {}) };
  const names = await git.listFiles({ fs, dir: "/repo" });
  assert.equal(names.length, 1000);
  let verified = 0;
  await git.walk({
    fs,
    dir: "/repo",
    trees: [git.STAGE()],
    map: async (path, [entry]) => {
      if ((await entry?.type()) !== "blob") return;
      const { blob } = await git.readBlob({ fs, dir: "/repo", oid: await entry.oid() });
      assert.equal(
        new TextDecoder().decode(blob),
        `file ${Number(path.slice(1))} ${["initial", "unchanged"].includes(process.env.ADD_MODE) || (process.env.ADD_MODE === "one" && path !== "f0") ? "old" : "new"}\n`.repeat(
          48,
        ),
      );
      verified++;
    },
  });
  assert.equal(verified, 1000);
  vfs.close();
  if (n >= 0) rows.push({ version, trial: n, ms, ...measured });
}
for (let n = profiling ? 0 : -3; n < (profiling ? 1 : 10); n++) {
  for (const version of pairOrder(n))
    await trial(version, version === "baseline" ? before : after, n);
  console.log(`pair ${n + 4}/13`);
}
const a = rows.filter((r) => r.version === "baseline"),
  b = rows.filter((r) => r.version === "candidate");
const summary = {
  baseline: distribution(a.map((r) => r.ms)),
  candidate: distribution(b.map((r) => r.ms)),
  ratio: pairedRatio(
    a.map((r) => r.ms),
    b.map((r) => r.ms),
  ),
  reads: [a[0].reads, b[0].reads],
  calls: [a[0].calls, b[0].calls],
};
await writeFile(
  out,
  JSON.stringify(
    {
      node: process.version,
      files: 1000,
      mode: process.env.ADD_MODE ?? "changed",
      warmupPairs: profiling ? 0 : 3,
      measuredPairs: profiling ? 1 : 10,
      profiling,
      timingCaveat: profiling
        ? "Instrumented counters only; wall times are not used for performance conclusions."
        : undefined,
      verifiedPerTrial: 1000,
      rows,
      summary,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(summary, null, 2));

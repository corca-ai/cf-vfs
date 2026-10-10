import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { distribution, pairedRatio, pairOrder } from "../comparison.mjs";

const [beforePath, afterPath, output] = process.argv.slice(2);
const versions = {};
for (const [name, path] of Object.entries({ baseline: beforePath, candidate: afterPath })) {
  const root = pathToFileURL(`${resolve(path)}/`);
  const { NodeSqlFileSystem } = await import(new URL("testing/node.js", root));
  const { createFsAdapter } = await import(new URL("fs/index.js", root));
  const { FsMetadataCache } = await import(new URL("fs/metadata.js", root));
  const pathTools = await import(new URL("core/path.js", root));
  let statements = 0;
  const cache = new FsMetadataCache();
  const vfs = new NodeSqlFileSystem({ onEvent: cache.onEvent, onStatement: () => statements++ });
  const fs = createFsAdapter(vfs, { metadataCache: cache }).promises;
  vfs.mkdir("/files");
  const body = "const value = 1;\n".repeat(48),
    binary = new TextEncoder().encode(body);
  for (let i = 0; i < 1000; i++) await fs.writeFile(`/files/f${i}`, body);
  versions[name] = {
    vfs,
    fs,
    cache,
    pathTools,
    body,
    binary,
    count: () => statements,
    reset: () => {
      statements = 0;
    },
  };
}
const names = [
  "binary-overwrite",
  "text-overwrite",
  "append",
  "read",
  "cached-stat",
  "uncached-stat",
  "readdir",
  "normalize",
  "mkdir",
  "create",
];
const results = [];
for (const operation of names) {
  const durations = { baseline: [], candidate: [] },
    costs = { baseline: [], candidate: [] };
  for (let trial = 0; trial < 13; trial++)
    for (const version of pairOrder(trial)) {
      const s = versions[version];
      if (operation === "cached-stat") await s.fs.readdir("/files");
      if (operation === "mkdir") {
        await s.fs.rm("/dirs", { recursive: true, force: true });
        await s.fs.mkdir("/dirs");
      }
      if (operation === "create") {
        await s.fs.rm("/created", { recursive: true, force: true });
        await s.fs.mkdir("/created");
      }
      s.reset();
      let sum = 0;
      const started = performance.now();
      for (
        let i = 0;
        i < (operation === "normalize" ? 100000 : operation === "readdir" ? 100 : 1000);
        i++
      ) {
        const path = `/files/f${i % 1000}`;
        if (operation === "binary-overwrite") await s.fs.writeFile(path, s.binary);
        else if (operation === "text-overwrite") await s.fs.writeFile(path, s.body);
        else if (operation === "append") await s.fs.writeFile(path, "a", { flag: "a" });
        else if (operation === "read") sum += (await s.fs.readFile(path, "utf8")).length;
        else if (operation === "cached-stat") sum += (await s.fs.stat(path)).size;
        else if (operation === "uncached-stat") sum += s.vfs.stat(path).sizeBytes;
        else if (operation === "readdir") sum += (await s.fs.readdir("/files")).length;
        else if (operation === "create") await s.fs.writeFile(`/created/f${i}`, s.body);
        else if (operation === "mkdir") await s.fs.mkdir(`/dirs/d${i}`);
        else sum += s.pathTools.normalizePath("/scratch/repo/d0/f123.txt").length;
      }
      const elapsed = performance.now() - started;
      if (operation === "read" || operation.includes("stat"))
        assert.equal(sum, 1000 * (s.body.length + 13));
      if (operation === "readdir") assert.equal(sum, 100000);
      if (operation === "mkdir") assert.equal(s.vfs.list("/dirs").length, 1000);
      if (operation === "create") {
        assert.equal(s.vfs.list("/created").length, 1000);
        assert.equal(await s.fs.readFile("/created/f999", "utf8"), s.body);
      }
      if (trial >= 3) {
        durations[version].push(elapsed);
        costs[version].push(s.count());
      }
    }
  results.push({
    operation,
    before: distribution(durations.baseline),
    after: distribution(durations.candidate),
    ratio: pairedRatio(durations.baseline, durations.candidate),
    samples: durations,
    statements: costs,
  });
}
for (const s of Object.values(versions)) s.vfs.close();
writeFileSync(
  output,
  `${JSON.stringify({ node: process.version, beforePath, afterPath, results }, null, 2)}\n`,
);
for (const r of results)
  console.log(
    r.operation,
    r.before.median.toFixed(2),
    "->",
    r.after.median.toFixed(2),
    r.ratio.median.toFixed(3),
    r.statements.baseline[0],
    "->",
    r.statements.candidate[0],
  );

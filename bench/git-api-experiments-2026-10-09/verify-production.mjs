import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";

const out = new URL("./", import.meta.url);
async function files(root) {
  const paths = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...(await files(path)));
    else if (entry.isFile() && path !== "demo/benchmark-build.ts") paths.push(path);
  }
  return paths;
}
const paths = [
  ...(await files("src")),
  ...(await files("demo")),
  "bench/remote-worker.ts",
  "package-lock.json",
  "wrangler.benchmark.jsonc",
].sort();
const hash = createHash("sha256"),
  manifest = [];
for (const path of paths) {
  const body = await readFile(path);
  hash.update(path);
  hash.update("\0");
  hash.update(body);
  hash.update("\0");
  manifest.push({ path, sha256: createHash("sha256").update(body).digest("hex") });
}
const implementation = hash.digest("hex");
const response = await fetch("https://vfs.borca.ai/api/benchmarks");
assert.equal(response.status, 200);
const saved = await response.json();
assert.equal(saved.status, "ready");
assert.equal(response.headers.get("x-vfs-build"), implementation);
assert.equal(response.headers.get("x-vfs-deployment"), saved.result.deploymentId);
assert.equal(saved.result.buildId, implementation);
const latest = JSON.parse(await readFile(new URL("cf-final-repeat.json", out), "utf8"));
assert.equal(saved.result.runId, latest.result.runId);
const requested = await fetch("https://vfs.borca.ai/api/benchmarks", { method: "POST" });
assert.equal(requested.status, 200);
const reused = await requested.json();
assert.equal(reused.reused, true);
assert.equal(reused.result.runId, saved.result.runId);
assert.equal(reused.modifiedAt, saved.modifiedAt);
assert.equal(reused.nextRunAt - saved.modifiedAt, 600000);
await writeFile(
  new URL("source-fingerprint.json", out),
  JSON.stringify(
    {
      implementation,
      deploymentId: saved.result.deploymentId,
      runId: saved.result.runId,
      files: manifest,
    },
    null,
    2,
  ),
);
await writeFile(
  new URL("public-reuse.json", out),
  JSON.stringify({ before: saved, reused }, null, 2),
);
console.log(
  JSON.stringify({
    implementation,
    deploymentId: saved.result.deploymentId,
    runId: saved.result.runId,
    files: paths.length,
    ttlMs: reused.nextRunAt - saved.modifiedAt,
    modifiedAt: saved.modifiedAt,
  }),
);

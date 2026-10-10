import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";

const root = new URL("./compiled/", import.meta.url);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function graph(base, prefix = "") {
  const result = {};
  for (const entry of await readdir(new URL(prefix, base), { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(result, await graph(base, `${path}/`));
    else if (entry.isFile() && path.endsWith(".js"))
      result[path] = await readFile(new URL(path, base), "utf8");
  }
  return result;
}
function graphDigest(files) {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).sort()) hash.update(`${path}\0`).update(files[path]);
  return hash.digest("hex");
}
const baseline = await graph(new URL("baseline/", root));
const graphs = {};
const manifest = {};
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "baseline") continue;
  const files = await graph(new URL(`${entry.name}/`, root));
  const changed = Object.fromEntries(
    Object.entries(files).filter(([path, bytes]) => bytes !== baseline[path]),
  );
  const removed = Object.keys(baseline).filter((path) => files[path] === undefined);
  const restored = { ...baseline, ...changed };
  for (const path of removed) delete restored[path];
  assert.equal(graphDigest(restored), graphDigest(files));
  manifest[entry.name] = {
    javascriptGraphSha256: graphDigest(files),
    files: Object.keys(files).length,
  };
  graphs[entry.name] = { ...manifest[entry.name], changed, removed };
}
manifest.baseline = {
  javascriptGraphSha256: graphDigest(baseline),
  files: Object.keys(baseline).length,
};
const original = Buffer.from(JSON.stringify({ baseline, graphs }));
const compressed = gzipSync(original, { level: 9 });
assert.deepEqual(gunzipSync(compressed), original);
await writeFile(new URL("compiled-graphs.json.gz", import.meta.url), compressed);
await writeFile(
  new URL("graph-manifest.json", import.meta.url),
  `${JSON.stringify({ ...manifest, archive: { originalBytes: original.length, compressedBytes: compressed.length, sha256: digest(original), compressedSha256: digest(compressed) } }, null, 2)}\n`,
);
console.log(
  `Archived ${Object.keys(graphs).length + 1} exact JavaScript graphs (${compressed.length} bytes)`,
);

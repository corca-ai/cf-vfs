import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const [before, after] = process.argv.slice(2);
async function graph(root, prefix = "") {
  const result = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await graph(root, name));
    else if (/\.(?:js|ts)$/u.test(name)) result[name] = await readFile(join(root, name), "utf8");
  }
  return result;
}
const graphs = { baseline: await graph(before), candidate: await graph(after) };
const versions = {};
for (const [version, sources] of Object.entries(graphs)) {
  const hash = createHash("sha256");
  const paths = Object.keys(sources)
    .filter((path) => path.endsWith(".js"))
    .sort();
  for (const path of paths) hash.update(path).update("\0").update(sources[path]).update("\0");
  versions[version] = { sha256: hash.digest("hex"), modules: paths.length };
}
assert.equal(versions.baseline.modules, 200);
await writeFile(
  new URL("compiled-graphs.json.gz", import.meta.url),
  gzipSync(JSON.stringify(graphs)),
);
await writeFile(
  new URL("graphs.json", import.meta.url),
  JSON.stringify({ baselineCommit: "f127785d3c552a114160e4a00d3c2149ec7e4559", versions }, null, 2),
);
console.log(versions);

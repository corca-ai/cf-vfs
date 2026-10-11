import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

const [destination] = process.argv.slice(2);
assert.ok(destination, "Use a new destination directory");
const graphs = JSON.parse(
  gunzipSync(await readFile(new URL("compiled-graphs.json.gz", import.meta.url))),
);
const { versions } = JSON.parse(await readFile(new URL("graphs.json", import.meta.url), "utf8"));
const experiments = JSON.parse(
  await readFile(new URL("experiments.json", import.meta.url), "utf8"),
);
for (const [version, graph] of Object.entries(graphs)) {
  const hash = createHash("sha256");
  for (const path of Object.keys(graph)
    .filter((path) => path.endsWith(".js"))
    .sort())
    hash.update(path).update("\0").update(graph[path]).update("\0");
  assert.equal(hash.digest("hex"), versions[version].sha256);
}
const parent = resolve(destination);
await mkdir(parent);
for (const [version, graph] of Object.entries({
  ...graphs,
  ...Object.fromEntries(
    Object.entries(experiments).map(([name, source]) => [
      name,
      { ...graphs.baseline, "src/core/path.js": source },
    ]),
  ),
})) {
  const root = join(parent, version);
  await mkdir(root);
  for (const [path, source] of Object.entries(graph)) {
    const target = resolve(root, path);
    assert.ok(target.startsWith(root + sep), "Archive path escaped destination");
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, source);
  }
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
}
await symlink("candidate", join(parent, "hybrid"), "dir");
console.log("Restored and hash-verified baseline/candidate and exploratory overlays");

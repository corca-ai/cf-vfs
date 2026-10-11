import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

const [destination] = process.argv.slice(2);
assert.ok(destination, "Use a new output directory");
const graphs = JSON.parse(
  gunzipSync(await readFile(new URL("compiled-graphs.json.gz", import.meta.url))),
);
const types = JSON.parse(
  gunzipSync(await readFile(new URL("compiled-types.json.gz", import.meta.url))),
);
const manifests = JSON.parse(await readFile(new URL("graphs.json", import.meta.url), "utf8"));
const parent = resolve(destination);
await mkdir(parent);
for (const version of ["baseline", "candidate"]) {
  const root = join(parent, version);
  await mkdir(root);
  const hash = createHash("sha256");
  for (const path of Object.keys(graphs[version]).sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(graphs[version][path]);
    hash.update("\0");
  }
  assert.equal(hash.digest("hex"), manifests[version].sha256);
  for (const [path, text] of Object.entries({ ...graphs[version], ...types[version] })) {
    const target = resolve(root, path);
    assert.ok(target.startsWith(root + sep), "Archive path escaped output directory");
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, text);
  }
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
}
console.log("Restored and hash-verified baseline/candidate graphs");

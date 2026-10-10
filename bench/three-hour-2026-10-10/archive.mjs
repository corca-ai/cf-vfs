import assert from "node:assert/strict";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";

const root = new URL("./", import.meta.url);
const archived = [];
for (const name of (await readdir(root)).sort()) {
  const patch = name.endsWith(".patch.txt");
  if (!patch && !name.endsWith(".json")) continue;
  const bytes = await readFile(new URL(name, root));
  if (!patch) {
    if (bytes.length < 500000) continue;
    let value;
    try {
      value = JSON.parse(bytes.toString());
    } catch {
      continue;
    }
    if (!value.metrics) continue; // Running and interrupted checkpoints remain untouched.
  }
  const zipped = gzipSync(bytes, { level: 9 });
  assert.deepEqual(gunzipSync(zipped), bytes);
  await writeFile(new URL(`${name}.gz`, root), zipped);
  await unlink(new URL(name, root));
  archived.push(name);
}
console.log(`Losslessly archived ${archived.length} completed results/patches`);

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";

const root = new URL("./", import.meta.url);
for (const name of await readdir(root)) {
  if (!/\.(json|log)$/.test(name) || name === "evidence-manifest.json") continue;
  const bytes = await readFile(new URL(name, root));
  if (name.endsWith(".json")) JSON.parse(bytes);
  if (bytes.length < 250_000) continue;
  const compressed = gzipSync(bytes);
  assert.deepEqual(gunzipSync(compressed), bytes);
  await writeFile(new URL(`${name}.gz`, root), compressed);
  await unlink(new URL(name, root));
}
const evidence = [];
for (const name of (await readdir(root)).sort()) {
  if (name === "evidence-manifest.json") continue;
  const bytes = await readFile(new URL(name, root));
  evidence.push({
    name,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
await writeFile(new URL("evidence-manifest.json", root), JSON.stringify(evidence, null, 2) + "\n");
console.log(`Losslessly archived and fingerprinted ${evidence.length} evidence files`);

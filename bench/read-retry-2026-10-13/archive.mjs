import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";

const root = new URL("./", import.meta.url);
// The final pass includes the clean cohort, after all clients/assessments finish.
const includeClean = process.argv.includes("--final");
for (const name of await readdir(root)) {
  if (
    !name.endsWith(".json") ||
    name === "evidence-manifest.json" ||
    (!includeClean && name.startsWith("cf-clean-"))
  )
    continue;
  const bytes = await readFile(new URL(name, root));
  JSON.parse(bytes);
  if (bytes.length < 250_000) continue;
  const compressed = gzipSync(bytes);
  assert.deepEqual(gunzipSync(compressed), bytes);
  await writeFile(new URL(`${name}.gz`, root), compressed);
  await unlink(new URL(name, root));
}
const evidence = [];
for (const name of (await readdir(root)).sort()) {
  if (!/\.(json|gz|patch|txt|log)$/.test(name) || name === "evidence-manifest.json") continue;
  const bytes = await readFile(new URL(name, root));
  evidence.push({
    name,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
await writeFile(new URL("evidence-manifest.json", root), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`Archived and fingerprinted ${evidence.length} evidence files`);

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const root = new URL("./", import.meta.url);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const diagnostics = new Set(["profile-aa.json", "cpu-baseline-summary.json"]);
for (const name of await readdir(root)) {
  if (!name.endsWith(".json") && !name.endsWith(".patch.txt")) continue;
  if (name === "cf-public-baseline.json") continue;
  const path = new URL(name, root);
  const bytes = await readFile(path);
  if (name.endsWith(".json")) {
    let value;
    try {
      value = JSON.parse(bytes);
    } catch {
      continue; // A running driver may be writing a checkpoint.
    }
    if (!Array.isArray(value.metrics) && !diagnostics.has(name)) continue;
    if (bytes.length < 512_000) continue;
  }
  const compressed = gzipSync(bytes, { level: 9 });
  assert.deepEqual(gunzipSync(compressed), bytes);
  await writeFile(new URL(`${name}.gz`, root), compressed);
  await unlink(path);
}
const evidence = [];
for (const name of (await readdir(root)).sort()) {
  if (!name.endsWith(".json.gz") && !name.endsWith(".patch.txt.gz")) continue;
  const compressed = await readFile(new URL(name, root));
  const bytes = gunzipSync(compressed);
  const value = name.endsWith(".json.gz") ? JSON.parse(bytes) : undefined;
  evidence.push({
    file: name,
    originalBytes: bytes.length,
    compressedBytes: compressed.length,
    sha256: sha256(bytes),
    compressedSha256: sha256(compressed),
    ...(value?.metrics === undefined
      ? { kind: value === undefined ? "patch" : "diagnostic" }
      : {
          kind: "paired-measurement",
          credentials: value.credentials ?? "none",
          trials: value.trials,
          fullPlan: value.fullPlan,
          metrics: value.metrics,
          regressions: value.regressions.length,
          confirmed: value.confirmed.length,
          costRegressions: value.costRegressions.length,
        }),
  });
}
await writeFile(new URL("inventory.json", root), `${JSON.stringify({ evidence }, null, 2)}\n`);
console.log(`Verified ${evidence.length} lossless archives in ${fileURLToPath(root)}`);

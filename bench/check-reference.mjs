import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

for (const root of ["demo/benchmark-reference", "demo/benchmark-task-reference"]) {
  const manifest = JSON.parse(await readFile(`${root}/manifest.json`, "utf8"));
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    sha(await readFile(`${root}/runtime.js`)),
    manifest.bundleSha256,
    "Frozen reference was modified",
  );
  for (const [file, hash] of Object.entries(manifest.inputs))
    assert.equal(
      sha(await readFile(file)),
      hash,
      `${file} changed: explicitly repin the reference and start a new series`,
    );
  const config = JSON.parse(await readFile("wrangler.benchmark.jsonc", "utf8"));
  assert.deepEqual(
    { date: config.compatibility_date, flags: config.compatibility_flags },
    manifest.compatibility,
    "Runtime compatibility changed: explicitly repin and start a new series",
  );
  assert.equal(
    sha(
      JSON.stringify({
        bundle: manifest.bundleSha256,
        inputs: manifest.inputs,
        compatibility: manifest.compatibility,
      }),
    ),
    manifest.seriesHash,
  );
  console.log(`Frozen benchmark reference verified: ${manifest.sourceCommit.slice(0, 8)}`);
}

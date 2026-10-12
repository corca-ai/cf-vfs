import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

// Explicit maintenance command; normal deployments VERIFY, never refresh the reference.
if (!process.argv.includes("--pin")) throw new Error("Use --pin to start a new reference series");
const task = process.argv.includes("--task");
const root = task ? "demo/benchmark-task-reference" : "demo/benchmark-reference";
const result = await build({
  entryPoints: [task ? "demo/benchmark-task-fixture.ts" : "demo/benchmark-fixture.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  packages: "external",
  write: false,
  metafile: true,
  legalComments: "inline",
});
const body = result.outputFiles[0].contents;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixtures = Object.keys(result.metafile.inputs)
  .filter((p) => p.startsWith("demo/"))
  .sort();
const inputs = {};
for (const file of [...fixtures, "package-lock.json"]) inputs[file] = sha(await readFile(file));
const config = JSON.parse(await readFile("wrangler.benchmark.jsonc", "utf8"));
const compatibility = { date: config.compatibility_date, flags: config.compatibility_flags };
const seriesHash = sha(JSON.stringify({ bundle: sha(body), inputs, compatibility }));
const manifest = {
  seriesHash,
  compatibility,
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  bundleSha256: sha(body),
  inputs,
  note: "Frozen library and fixture implementation. Dependencies are pinned by lockfile. Repinning starts an incompatible measurement series.",
};
await writeFile(`${root}/runtime.js`, body);
await writeFile(`${root}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Pinned ${manifest.sourceCommit}: ${manifest.bundleSha256}`);

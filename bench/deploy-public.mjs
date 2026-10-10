import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";

async function files(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...(await files(path)));
    else if (entry.isFile() && path !== "demo/benchmark-build.ts") paths.push(path);
  }
  return paths;
}
const hash = createHash("sha256");
const paths = [
  ...(await files("src")),
  ...(await files("demo")),
  "bench/remote-worker.ts",
  "package-lock.json",
  "wrangler.benchmark.jsonc",
].sort();
for (const path of paths) {
  hash.update(path);
  hash.update("\0");
  hash.update(await readFile(path));
  hash.update("\0");
}
const id = hash.digest("hex");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
  encoding: "utf8",
})
  .split("\n")
  .filter((line) => line && line.slice(3) !== "demo/benchmark-build.ts");
if (dirty.length > 0)
  throw new Error(
    "Commit source changes before deploying so benchmark history identifies the measured commit.",
  );
await writeFile(
  "demo/benchmark-build.ts",
  `/** Generated deployment fingerprint; includes library, demo, config and lockfile. */\nexport const BENCHMARK_BUILD_ID =\n  "${id}";\nexport const BENCHMARK_COMMIT_HASH = "${commit}";\n`,
);
console.log(`Implementation: ${id}`);
const child = spawn("npx", ["wrangler", "deploy", "--config", "wrangler.benchmark.jsonc"], {
  stdio: "inherit",
});
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
if (code !== 0) process.exit(code ?? 1);

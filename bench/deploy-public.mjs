import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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
const configIndex = process.argv.indexOf("--config");
const config = configIndex < 0 ? "wrangler.benchmark.jsonc" : process.argv[configIndex + 1];
if (!config || config.startsWith("--")) throw new Error("--config needs a path");
execFileSync(process.execPath, ["bench/check-reference.mjs"], { stdio: "inherit" });
const deployment = JSON.parse(await readFile(config, "utf8"));
const hash = createHash("sha256");
const paths = [
  ...(await files("src")),
  ...(await files("demo")),
  "bench/remote-worker.ts",
  "bench/metered-sql.ts",
  ...(config === "wrangler.benchmark.jsonc"
    ? []
    : [config, join(dirname(config), deployment.main)]),
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
const secretIndex = process.argv.indexOf("--secrets-file");
const secretsFile = secretIndex < 0 ? undefined : process.argv[secretIndex + 1];
if (secretIndex >= 0 && !secretsFile) throw new Error("--secrets-file needs a path");
// Deploy with the `cf` CLI, never `wrangler deploy`: the Worker's Durable Objects
// are declared as `exports` in eval/benchmark-deploy/cloudflare.config.ts, and a
// Worker deployed that way cannot go back to wrangler's `migrations` array.
if (config !== "wrangler.benchmark.jsonc") {
  throw new Error("Only the public benchmark Worker deploys from here, with cf.");
}
const cf = resolve("eval/node_modules/.bin/cf");
// `cf` looks for its tooling in the project's own node_modules; share eval's.
const linked = resolve("eval/benchmark-deploy/node_modules");
if (!(await lstat(linked).catch(() => undefined))) await symlink("../node_modules", linked, "dir");
const child = spawn(
  cf,
  ["deploy", ...(secretsFile === undefined ? [] : ["--secrets-file", resolve(secretsFile)])],
  { cwd: resolve("eval/benchmark-deploy"), stdio: "inherit" },
);
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
if (code !== 0) process.exit(code ?? 1);

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const [source, target] = process.argv.slice(2).map((p) => resolve(p));
if (!source || !target || target === source)
  throw new Error("Separate source and output paths required");
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await writeFile(join(target, "package.json"), '{"type":"module"}');
await symlink(resolve("node_modules"), join(target, "node_modules"), "dir");
const config = join(target, "tsconfig.json");
await writeFile(
  config,
  JSON.stringify({
    extends: join(source, "tsconfig.build.json"),
    compilerOptions: { rootDir: source, outDir: target, declaration: true, noEmit: false },
    include: [join(source, "src/**/*.ts"), join(source, "demo/benchmark-suite.ts")],
    exclude: [],
  }),
);
execFileSync(resolve("node_modules/.bin/tsc"), ["-p", config], { stdio: "inherit" });
const files = [];
async function visit(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (entry.name.endsWith(".js")) files.push(path);
  }
}
await visit(target);
files.sort();
const hash = createHash("sha256");
for (const path of files) {
  hash.update(relative(target, path));
  hash.update("\0");
  hash.update(await readFile(path));
  hash.update("\0");
}
const manifest = { sha256: hash.digest("hex"), files: files.map((path) => relative(target, path)) };
await writeFile(join(target, "graph.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(manifest.sha256, files.length);

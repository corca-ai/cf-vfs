import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = new URL("..", import.meta.url);
const temporaryRoot = await mkdtemp(join(tmpdir(), "cf-vfs-package-"));
const packageDirectory = join(temporaryRoot, "package");
const consumerDirectory = join(temporaryRoot, "consumer");

try {
  await mkdir(packageDirectory, { recursive: true });
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", packageDirectory],
    { cwd: packageRoot },
  );
  const [{ filename, files }] = JSON.parse(stdout);
  assert(files.some(({ path }) => path === "dist/commands/ls.js"));
  assert(files.some(({ path }) => path === "dist/commands/ls.d.ts"));
  for (const command of [
    "basename",
    "chmod",
    "cmp",
    "comm",
    "diff",
    "dirname",
    "du",
    "fold",
    "join",
    "mktemp",
    "nl",
    "paste",
    "patch",
    "pwd",
    "realpath",
    "sha256sum",
    "sort",
    "tee",
    "test",
    "touch",
    "tree",
    "uniq",
    "cut",
    "tr",
  ]) {
    assert(files.some(({ path }) => path === `dist/commands/${command}.js`));
    assert(files.some(({ path }) => path === `dist/commands/${command}.d.ts`));
  }
  assert(files.some(({ path }) => path === "docs/index.md"));
  assert(!files.some(({ path }) => path.startsWith("src/")));

  await mkdir(consumerDirectory, { recursive: true });
  await writeFile(
    join(consumerDirectory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await execFileAsync(
    "npm",
    ["install", "--ignore-scripts", "--no-package-lock", join(packageDirectory, filename)],
    { cwd: consumerDirectory },
  );

  const modulePath = join(
    consumerDirectory,
    "node_modules",
    "@corca-ai",
    "cf-vfs",
    "dist",
    "commands",
    "ls.js",
  );
  const source = await readFile(modulePath, "utf8");
  assert(source.includes('name: "ls"'));
  const packageFiles = await readdir(join(consumerDirectory, "node_modules", "@corca-ai", "cf-vfs"));
  assert(packageFiles.includes("dist"));
  assert(!packageFiles.includes("src"));
  console.log("package tarball and command subpath verified");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

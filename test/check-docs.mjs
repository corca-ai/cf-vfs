import assert from "node:assert/strict";
import { lstat, readFile, readlink, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = new URL("..", import.meta.url);
const documents = [
  "README.md",
  "AGENTS.md",
  "docs/index.md",
  "docs/getting-started.md",
  "docs/commands.md",
  "docs/architecture.md",
  "docs/posix-compatibility.md",
  "docs/parser-spike.md",
  "docs/performance.md",
  "docs/operations.md",
  "docs/development.md",
  "bench/baseline-2026-07-20.md",
];

let combined = "";
for (const document of documents) {
  const absoluteDocument = resolve(root.pathname, document);
  const contents = await readFile(absoluteDocument, "utf8");
  combined += `\n${contents}`;
  for (const match of contents.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    const path = resolve(dirname(absoluteDocument), target.split("#", 1)[0]);
    await stat(path).catch(() => {
      throw new Error(`${document} contains a broken link to ${target}`);
    });
  }
}

for (const stale of ["CommandExecutor", "R2BinaryStore", "ENOTTEXT", "drainBinaryGarbage"]){
  assert(!combined.includes(stale), `documentation still references removed ${stale}`);
}
assert(combined.includes("BASH_COMPATIBILITY_VERSION"));
assert(combined.toLowerCase().includes("atomic redirection divergence"));
assert(combined.includes("opaque-gc-batch") || combined.includes("64-object GC batch"));

const claude = await lstat(new URL("../CLAUDE.md", import.meta.url));
assert(claude.isSymbolicLink());
assert.equal(await readlink(new URL("../CLAUDE.md", import.meta.url)), "AGENTS.md");
console.log("documentation links and CLAUDE.md symlink verified");

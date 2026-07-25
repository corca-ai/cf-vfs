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
  "bench/node-sql-baseline-2026-07-25.md",
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

for (const stale of [
  "CommandExecutor",
  "R2BinaryStore",
  "ENOTTEXT",
  "drainBinaryGarbage",
  "MemoryFileSystem",
  "vfs/memory",
]) {
  assert(!combined.includes(stale), `documentation still references removed ${stale}`);
}
assert(combined.includes("BASH_COMPATIBILITY_VERSION"));
assert(combined.toLowerCase().includes("atomic redirection divergence"));
assert(combined.includes("opaque-gc-batch") || combined.includes("64-object GC batch"));

// Every applet in the convenience preset must appear in the command reference.
// The registry is now self-describing, so an undocumented addition is a
// failure rather than something a reader discovers at runtime.
const { defaultShellCommands } = await import(
  new URL("../dist/shell/commands/default.js", import.meta.url).href
);
const commandReference = await readFile(resolve(root.pathname, "docs/commands.md"), "utf8");
const documented = new Set(
  [...commandReference.matchAll(/`([^`\s]+)[^`]*`/g)].map((match) => match[1]),
);
for (const { name } of defaultShellCommands) {
  assert(documented.has(name), `docs/commands.md does not document the ${name} applet`);
}

const claude = await lstat(new URL("../CLAUDE.md", import.meta.url));
assert(claude.isSymbolicLink());
assert.equal(await readlink(new URL("../CLAUDE.md", import.meta.url)), "AGENTS.md");
console.log(
  `documentation links, ${defaultShellCommands.length} documented applets, and the CLAUDE.md symlink verified`,
);

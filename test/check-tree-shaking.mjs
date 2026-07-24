import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repository = new URL("..", import.meta.url);

async function bundle(config) {
  const outputDirectory = await mkdtemp(join(tmpdir(), "cloudflare-vfs-tree-shake-"));
  try {
    await execFileAsync(
      process.platform === "win32" ? "wrangler.cmd" : "wrangler",
      ["deploy", "--dry-run", "--config", config, "--outdir", outputDirectory],
      { cwd: repository },
    );
    const files = await readdir(outputDirectory);
    const workerFile = files.find((file) => file.endsWith(".js"));
    if (!workerFile) throw new Error("Wrangler did not emit a JavaScript worker bundle");
    return await readFile(join(outputDirectory, workerFile), "utf8");
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

const lsBundle = await bundle("wrangler.tree-shake.jsonc");
assert.match(lsBundle, /lsCommand|name:\s*"ls"/u);
for (const excluded of [
  "mkdir: missing operand",
  "find: -name requires a pattern",
  "mktemp: template must contain XXXXXX",
  "opaque R2 content",
  "shell AST node limit exceeded",
]) assert(!lsBundle.includes(excluded), `ls-only bundle contains ${excluded}`);

const vfsBundle = await bundle("wrangler.vfs-tree-shake.jsonc");
for (const excluded of [
  "shell AST node limit exceeded",
  "command not found",
  "mkdir: missing operand",
  "opaque R2 content",
]) assert(!vfsBundle.includes(excluded), `VFS-only bundle contains ${excluded}`);

const commandsBundle = await bundle("wrangler.commands-tree-shake.jsonc");
assert.match(commandsBundle, /cat.*grep|grep.*cat/u);
for (const excluded of [
  "mkdir: missing operand",
  "mktemp: template must contain XXXXXX",
  "diff: requires two files",
  "patch: usage",
  "join: requires two files",
  "opaque R2 content",
]) assert(!commandsBundle.includes(excluded), `cat+grep bundle contains ${excluded}`);

const nonInteractiveShellBundle = await bundle("wrangler.shell-tree-shake.jsonc");
for (const excluded of [
  "interactive shell is closed",
  "interactive shell already has an active execution",
]) {
  assert(
    !nonInteractiveShellBundle.includes(excluded),
    `non-interactive shell bundle contains ${excluded}`,
  );
}

const interactiveShellBundle = await bundle("wrangler.interactive-tree-shake.jsonc");
assert(
  interactiveShellBundle.includes("interactive shell is closed"),
  "interactive shell bundle is missing interactive session behavior",
);

console.log(
  `tree-shaking verified (ls ${Buffer.byteLength(lsBundle)} bytes, commands ${Buffer.byteLength(commandsBundle)} bytes, VFS ${Buffer.byteLength(vfsBundle)} bytes, shell ${Buffer.byteLength(nonInteractiveShellBundle)} bytes, interactive ${Buffer.byteLength(interactiveShellBundle)} bytes)`,
);

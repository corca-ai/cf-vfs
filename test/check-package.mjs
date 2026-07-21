import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
  for (const path of [
    "dist/index.js",
    "dist/vfs/index.js",
    "dist/vfs/do-sql.js",
    "dist/shell/index.js",
    "dist/shell/commands/index.js",
    "dist/shell/commands/default.js",
    "dist/shell/commands/ls.js",
    "dist/storage/r2.js",
    "dist/durable-object.js",
    "dist/testing/index.js",
    "docs/index.md",
  ]) assert(files.some((file) => file.path === path), `package is missing ${path}`);
  for (const removed of [
    "dist/core/command.js",
    "dist/core/executor.js",
    "dist/core/validation.js",
    "dist/commands/index.js",
  ]) assert(!files.some((file) => file.path === removed), `package contains removed ${removed}`);
  assert(!files.some(({ path }) => path.startsWith("src/")));

  await mkdir(consumerDirectory, { recursive: true });
  await writeFile(
    join(consumerDirectory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await execFileAsync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      join(packageDirectory, filename),
      "typescript@7.0.2",
      "@cloudflare/workers-types@5.20260719.1",
    ],
    { cwd: consumerDirectory },
  );
  await writeFile(join(consumerDirectory, "probe.mjs"), `
    import { MAX_INLINE_FILE_BYTES } from "@corca-ai/cf-vfs";
    import { Shell, BASH_COMPATIBILITY_VERSION, parseShellScript } from "@corca-ai/cf-vfs/shell";
    import { lsCommand } from "@corca-ai/cf-vfs/shell/commands/ls";
    import { defaultShellCommands } from "@corca-ai/cf-vfs/shell/commands/default";
    import { MemoryFileSystem } from "@corca-ai/cf-vfs/testing";
    if (MAX_INLINE_FILE_BYTES !== 8 * 1024 * 1024) throw new Error("inline limit");
    if (BASH_COMPATIBILITY_VERSION !== 4) throw new Error("language version");
    if (lsCommand.name !== "ls") throw new Error("ls export");
    const parsed = parseShellScript('printf "%s" "$VALUE"', 100);
    const expansion = parsed.lists[0].first.commands[0].words[2].parts[0].expansion;
    if ("kind" in expansion || expansion.length !== false || expansion.operator !== undefined) {
      throw new Error("Version 2 parameter AST compatibility");
    }
    const conditional = parseShellScript("[[ value == v* ]]", 100)
      .lists[0]?.first.commands[0];
    if (conditional?.type !== "double-bracket"
      || conditional.expression.type !== "conditional-binary") {
      throw new Error("Version 3 double-bracket AST export");
    }
    const shell = new Shell({ fileSystem: new MemoryFileSystem(), commands: defaultShellCommands });
    const result = await shell.executeText({ script: 'X=$(printf ok); printf "package-%s" "$X"' });
    if (result.stdout !== "package-ok") throw new Error("shell execution");
  `);
  await execFileAsync("node", ["probe.mjs"], { cwd: consumerDirectory });
  await writeFile(join(consumerDirectory, "probe.ts"), `
    import {
      Shell,
      type ExecuteBytesResult,
      type ExecuteTextResult,
      type ParameterExpansion,
      type ParameterOperator,
      type ShellWord,
    } from "@corca-ai/cf-vfs/shell";
    import { defaultShellCommands } from "@corca-ai/cf-vfs/shell/commands/default";
    import { MemoryFileSystem } from "@corca-ai/cf-vfs/testing";
    const shell = new Shell({ fileSystem: new MemoryFileSystem(), commands: defaultShellCommands });
    const text: Promise<ExecuteTextResult> = shell.executeText({ script: "printf text" });
    const bytes: Promise<ExecuteBytesResult> = shell.executeBytes({ script: "printf bytes" });
    const legacyExpansion: ParameterExpansion = { name: "VALUE", length: false };
    const legacyLength: boolean = legacyExpansion.length;
    const legacyOperator: ParameterOperator | undefined = legacyExpansion.operator;
    const legacyWord: ShellWord | undefined = legacyExpansion.word;
    void [legacyLength, legacyOperator, legacyWord];
    void Promise.all([text, bytes]);
  `);
  await writeFile(join(consumerDirectory, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "es2022",
      module: "nodenext",
      moduleResolution: "nodenext",
      strict: true,
      types: ["@cloudflare/workers-types"],
      skipLibCheck: true,
      noEmit: true,
    },
    include: ["probe.ts"],
  }));
  await execFileAsync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: consumerDirectory });

  for (const hidden of [
    "@corca-ai/cf-vfs/shell/commands/helpers",
    "@corca-ai/cf-vfs/vfs/memory",
  ]) {
    await assert.rejects(import(hidden), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  }

  const packageFiles = await readdir(join(consumerDirectory, "node_modules", "@corca-ai", "cf-vfs"));
  assert(packageFiles.includes("dist"));
  assert(!packageFiles.includes("src"));
  console.log("package tarball, runtime/type consumers, and explicit exports verified");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

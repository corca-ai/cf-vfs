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
    "dist/vfs/sql.js",
    "dist/shell/index.js",
    "dist/shell/interactive.js",
    "dist/shell/commands/index.js",
    "dist/shell/commands/applet.js",
    "dist/shell/commands/discovery.js",
    "dist/shell/commands/sh.js",
    "dist/shell/linux.js",
    "dist/shell/commands/default.js",
    "dist/shell/commands/ls.js",
    "dist/storage/r2.js",
    "dist/durable-object.js",
    "dist/testing/index.js",
    "dist/testing/node.js",
    "docs/index.md",
  ])
    assert(
      files.some((file) => file.path === path),
      `package is missing ${path}`,
    );
  for (const removed of [
    "dist/core/command.js",
    "dist/core/executor.js",
    "dist/core/validation.js",
    "dist/commands/index.js",
    "dist/testing/memory.js",
    "dist/vfs/memory.js",
  ])
    assert(!files.some((file) => file.path === removed), `package contains removed ${removed}`);
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
      "@types/node@24.13.3",
      "@cloudflare/workers-types@5.20260719.1",
    ],
    { cwd: consumerDirectory },
  );
  await writeFile(
    join(consumerDirectory, "probe.mjs"),
    `
    import { MAX_INLINE_FILE_BYTES } from "@corca-ai/cf-vfs";
    import { Shell, BASH_COMPATIBILITY_VERSION, parseShellScript } from "@corca-ai/cf-vfs/shell";
    import { InteractiveShell } from "@corca-ai/cf-vfs/shell/interactive";
    import { lsCommand } from "@corca-ai/cf-vfs/shell/commands/ls";
    import { createAppletRegistry, defineApplet } from "@corca-ai/cf-vfs/shell/commands/applet";
    import { typeCommand, whichCommand } from "@corca-ai/cf-vfs/shell/commands/discovery";
    import {
      LINUX_APPLET_DIRECTORIES,
      LINUX_SHELL_OPTIONS,
      linuxShellEnvironment,
      provisionLinuxFilesystem,
    } from "@corca-ai/cf-vfs/shell/linux";
    import { defaultShellCommands } from "@corca-ai/cf-vfs/shell/commands/default";
    import { MemoryOpaqueStore } from "@corca-ai/cf-vfs/testing";
    import { NodeSqlFileSystem } from "@corca-ai/cf-vfs/testing/node";
    if (MAX_INLINE_FILE_BYTES !== 8 * 1024 * 1024) throw new Error("inline limit");
    if (BASH_COMPATIBILITY_VERSION !== 4) throw new Error("language version");
    if (lsCommand.name !== "ls") throw new Error("ls export");
    const applets = createAppletRegistry([
      lsCommand,
      defineApplet({ name: "probe", aliases: ["p"], usage: "", summary: "probe" }, () => 0),
    ]);
    for (const spelling of ["/bin/ls", "/usr/bin/ls"]) {
      if (applets.findPath(spelling)?.command !== lsCommand) {
        throw new Error("applet path " + spelling);
      }
    }
    if (applets.find("ls")?.command !== lsCommand) throw new Error("applet name");
    if (applets.find("p")?.command.name !== "probe") throw new Error("applet alias");
    if (applets.findPath("/sbin/ls") !== undefined) throw new Error("unexpected applet directory");
    if (typeCommand.name !== "type" || whichCommand.name !== "which") {
      throw new Error("discovery exports");
    }
    if (linuxShellEnvironment().PATH !== LINUX_APPLET_DIRECTORIES.join(":")) {
      throw new Error("linux profile PATH");
    }
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
    if (typeof MemoryOpaqueStore !== "function") throw new Error("testing export");
    const fileSystem = new NodeSqlFileSystem();
    const shell = new Shell({ fileSystem, commands: defaultShellCommands });
    const result = await shell.executeText({ script: 'X=$(printf ok); printf "package-%s" "$X"' });
    if (result.stdout !== "package-ok") throw new Error("shell execution");
    provisionLinuxFilesystem(fileSystem);
    const linuxShell = new Shell({
      fileSystem,
      commands: defaultShellCommands,
      ...LINUX_SHELL_OPTIONS,
    });
    const discovery = await linuxShell.executeText({
      script: "cd $HOME; pwd; command -v grep",
      env: linuxShellEnvironment(),
    });
    if (discovery.stdout !== "/home/cf\\n/bin/grep\\n") {
      throw new Error("linux profile execution: " + discovery.stdout + discovery.stderr);
    }
    const interactive = new InteractiveShell({
      fileSystem,
      commands: defaultShellCommands,
    });
    await interactive.runText({ script: "VALUE=kept" });
    const interactiveResult = await interactive.runText({ script: "printf '%s' \\"$VALUE\\"" });
    if (interactiveResult.stdout !== "kept") throw new Error("interactive shell execution");
    fileSystem.close();
  `,
  );
  await execFileAsync("node", ["probe.mjs"], { cwd: consumerDirectory });
  await writeFile(
    join(consumerDirectory, "probe.ts"),
    `
    import {
      Shell,
      type ExecuteBytesResult,
      type ExecuteTextResult,
      type ParameterExpansion,
      type ParameterOperator,
      type ShellWord,
    } from "@corca-ai/cf-vfs/shell";
    import {
      InteractiveShell as InteractiveShellClass,
      type InteractiveShellSnapshot,
    } from "@corca-ai/cf-vfs/shell/interactive";
    import { defaultShellCommands } from "@corca-ai/cf-vfs/shell/commands/default";
    import { NodeSqlFileSystem } from "@corca-ai/cf-vfs/testing/node";
    const fileSystem = new NodeSqlFileSystem();
    const shell = new Shell({ fileSystem, commands: defaultShellCommands });
    const text: Promise<ExecuteTextResult> = shell.executeText({ script: "printf text" });
    const bytes: Promise<ExecuteBytesResult> = shell.executeBytes({ script: "printf bytes" });
    const legacyExpansion: ParameterExpansion = { name: "VALUE", length: false };
    const legacyLength: boolean = legacyExpansion.length;
    const legacyOperator: ParameterOperator | undefined = legacyExpansion.operator;
    const legacyWord: ShellWord | undefined = legacyExpansion.word;
    const interactive: InteractiveShellClass = new InteractiveShellClass({
      fileSystem,
      commands: defaultShellCommands,
    });
    const snapshot: InteractiveShellSnapshot = interactive.snapshot();
    void [legacyLength, legacyOperator, legacyWord];
    void snapshot;
    void Promise.all([text, bytes, interactive.runText({ script: "true" })])
      .finally(() => fileSystem.close());
  `,
  );
  await writeFile(
    join(consumerDirectory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "es2022",
        module: "nodenext",
        moduleResolution: "nodenext",
        strict: true,
        types: ["@cloudflare/workers-types", "node"],
        skipLibCheck: true,
        noEmit: true,
      },
      include: ["probe.ts"],
    }),
  );
  await execFileAsync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: consumerDirectory });

  for (const hidden of [
    "@corca-ai/cf-vfs/shell/commands/helpers",
    "@corca-ai/cf-vfs/shell/session",
    "@corca-ai/cf-vfs/vfs/memory",
  ]) {
    await assert.rejects(import(hidden), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  }

  const packageFiles = await readdir(
    join(consumerDirectory, "node_modules", "@corca-ai", "cf-vfs"),
  );
  assert(packageFiles.includes("dist"));
  assert(!packageFiles.includes("src"));
  console.log("package tarball, runtime/type consumers, and explicit exports verified");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

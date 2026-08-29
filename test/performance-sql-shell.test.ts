import { expect, it } from "vitest";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { Shell } from "../src/shell/shell.js";
import type { NodeSqlFileSystem } from "../src/testing/node.js";
import { meteredFileSystem } from "./helpers/performance.js";

it("charges no storage work to applet resolution", async () => {
  const { fileSystem, meter } = meteredFileSystem();
  const shell = new Shell({ fileSystem, commands: defaultShellCommands });
  // Prove the meter observes this filesystem before asserting a zero.
  await fileSystem.writeFile("/probe", "x");
  meter.reset();
  await shell.executeText({ script: "cat /probe" });
  expect(meter.statements).toBeGreaterThan(0);

  meter.reset();
  const result = await shell.executeText({
    script: "index=0; while [ $index -lt 200 ]; do true; index=$((index + 1)); done; echo done",
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("done\n");
  // Resolving a registered applet is a JavaScript map lookup. A PATH search
  // over real namespace entries is a separate, budgeted concern; this guard
  // covers applet resolution and must keep covering it.
  expect(meter.statements).toBe(0);
});

it("charges no storage work to a PATH search or to command discovery", async () => {
  const { fileSystem, meter } = meteredFileSystem();
  const shell = new Shell({
    fileSystem,
    commands: defaultShellCommands,
    commandResolution: "path",
  });
  await fileSystem.writeFile("/probe", "x");
  meter.reset();
  await shell.executeText({ script: "cat /probe" });
  expect(meter.statements).toBeGreaterThan(0);

  meter.reset();
  const result = await shell.executeText({
    script: [
      "PATH=/usr/bin:/bin",
      "index=0",
      "while [ $index -lt 100 ]; do true; index=$((index + 1)); done",
      "command -v grep",
      "type cat",
      "which sort",
    ].join("\n"),
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("/usr/bin/grep\ncat is /usr/bin/cat\n/usr/bin/sort\n");
  // A PATH search walks a JavaScript array of components. Discovery reuses
  // the same resolver, so neither may reach storage.
  expect(meter.statements).toBe(0);
});

it("resolves a virtual applet path with the same storage cost as a bare name", async () => {
  const { fileSystem, meter } = meteredFileSystem();
  const shell = new Shell({ fileSystem, commands: defaultShellCommands });
  await fileSystem.writeFile("/probe", "x");
  meter.reset();
  await shell.executeText({ script: "cat /probe" });
  expect(meter.statements).toBeGreaterThan(0);

  meter.reset();
  await shell.executeText({ script: "echo bare" });
  const bare = meter.statements;
  meter.reset();
  await shell.executeText({ script: "/bin/echo absolute" });
  expect(meter.statements).toBe(bare);
  expect(bare).toBe(0);
});

it("reads an executable script once and charges nothing to a bare applet", async () => {
  const { fileSystem, meter } = meteredFileSystem();
  await fileSystem.writeFile("/w/run.sh", "#!/bin/sh\nprintf ran\n", { createParents: true });
  fileSystem.setMetadata("/w/run.sh", { mode: 0o100755 });
  const shell = new Shell({
    fileSystem,
    commands: defaultShellCommands,
    commandResolution: "path",
  });

  meter.reset();
  const script = await shell.executeText({ script: "/w/run.sh" });
  expect(script.stdout).toBe("ran");
  // One stat to classify the file plus the inline read. A resolution that
  // probed every PATH component, or read the file twice for the shebang and
  // then for the source, would show up here immediately.
  expect(meter.statements).toBeGreaterThan(0);
  expect(meter.statements).toBeLessThanOrEqual(4);

  // A bare applet name never touches storage, even with the search enabled.
  meter.reset();
  await shell.executeText({ script: "PATH=/bin:/usr/bin printf ok" });
  expect(meter.statements).toBe(0);
});

it("walks a subtree with one set-based traversal", async () => {
  const { fileSystem, meter } = meteredFileSystem();
  for (let index = 0; index < 20; index += 1) {
    await fileSystem.writeFile(`/tree/branch-${index}/leaf`, "x", { createParents: true });
  }
  const shell = new Shell({ fileSystem, commands: defaultShellCommands });
  meter.reset();
  const result = await shell.executeText({ script: "find /tree -type f | wc -l" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("20\n");
  // A JavaScript directory walk would issue one query per directory.
  expect(meter.statements).toBeGreaterThan(0);
  expect(meter.statements).toBeLessThanOrEqual(4);
});

it("preflights credential permissions once across materialized find pages", async () => {
  const { fileSystem, meter } = meteredFileSystem();
  fileSystem.mkdir("/tree");
  for (let index = 0; index < 1_005; index += 1) {
    await fileSystem.writeFile(`/tree/file-${index.toString().padStart(4, "0")}`, "x");
  }

  meter.reset();
  const user = fileSystem.forCredentials({ uid: 1_000, gid: 1_000 });
  const entries = user.find({ path: "/tree", includeRoot: true });
  expect(entries).toHaveLength(1_006);
  // Root classification, traversal, and the set-based permission preflight
  // are paid once for the whole materializing find(), not once per page.
  expect(meter.statements).toBe(5);

  meter.reset();
  const shell = new Shell({ fileSystem: user, commands: defaultShellCommands });
  const result = await shell.executeText({ script: "find /tree -type f | wc -l" });
  expect(result).toMatchObject({ exitCode: 0, stdout: "1005\n" });
  // The shell must keep using the materializing traversal above: manually
  // paging a credential view repeats the whole permission preflight.
  expect(meter.statements).toBeGreaterThanOrEqual(5);
  expect(meter.statements).toBeLessThanOrEqual(8);
});

it("keeps credential-bound recursive copy set-based as the subtree grows", async () => {
  const { fileSystem, meter } = meteredFileSystem();
  fileSystem.mkdir("/destination");
  fileSystem.setMetadata("/destination", { mode: 0o040777 });
  for (let index = 0; index < 20; index += 1) {
    await fileSystem.writeFile(`/small/dir-${index}/file`, "x", { createParents: true });
  }
  for (let index = 0; index < 40; index += 1) {
    await fileSystem.writeFile(`/large/dir-${index}/file`, "x", { createParents: true });
  }
  const user = fileSystem.forCredentials({ uid: 1_000, gid: 1_000 });

  meter.reset();
  const small = await user.copy("/small", "/destination/small", { recursive: true });
  const smallStatements = meter.statements;
  expect(smallStatements).toBe(14);

  // Copy conservatively invalidates the symlink-count cache. Refresh it
  // outside both measurements so subtree size is the only variable.
  fileSystem.realpath("/destination/small");
  meter.reset();
  const large = await user.copy("/large", "/destination/large", { recursive: true });
  expect(meter.statements).toBe(smallStatements);
  expect(large.copied).toBeGreaterThan(small.copied);
});

it("walks a credential-bound creation parent only once per transaction", async () => {
  async function statements(
    operation: (fileSystem: ReturnType<NodeSqlFileSystem["forCredentials"]>) => unknown,
    root = "/home",
  ): Promise<number> {
    const { fileSystem, meter } = meteredFileSystem();
    fileSystem.mkdir(root);
    fileSystem.setOwnership(root, { uid: 1_000, gid: 1_000 });
    fileSystem.setMetadata(root, { mode: 0o040700 });
    const user = fileSystem.forCredentials({
      uid: 1_000,
      gid: 1_000,
      supplementaryGids: [1_001],
    });
    meter.reset();
    await operation(user);
    return meter.statements;
  }

  expect({
    touch: await statements((fileSystem) => fileSystem.touch("/home/touch")),
    mkdir: await statements((fileSystem) => fileSystem.mkdir("/home/dir")),
    symlink: await statements((fileSystem) => fileSystem.symlink("/home/link", "/target")),
    write: await statements((fileSystem) => fileSystem.writeFile("/home/file", "x")),
    recursiveTouch: await statements(
      (fileSystem) => fileSystem.touch("/deep/a/b/c/file", { createParents: true }),
      "/deep",
    ),
  }).toEqual({
    touch: 9,
    mkdir: 9,
    symlink: 9,
    write: 12,
    recursiveTouch: 21,
  });
});

import { expect, it } from "vitest";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import type { ShellEvent } from "../src/shell/events.js";
import { Shell } from "../src/shell/shell.js";
import { MemoryOpaqueStore } from "../src/testing/opaque-store.js";
import { putOpaque } from "../src/vfs/opaque.js";
import { createBashHarness } from "./helpers/bash.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

it("makes diff output consumable by patch", async () => {
  const { fileSystem, shell } = createBashHarness();
  await fileSystem.writeFile("/before", "one\ntwo\n");
  await fileSystem.writeFile("/after", "one\nchanged\n");
  const result = await shell.executeText({
    script:
      "diff /before /after > /change.patch || :; patch /before /change.patch; cmp /before /after",
  });
  expect(result).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
});

it("reports commands, executions, and the limit that refused work", async () => {
  const events: ShellEvent[] = [];
  const fileSystem = createTestFileSystem();
  const shell = new Shell({
    fileSystem,
    commands: defaultShellCommands,
    onEvent: (event) => events.push(event),
  });

  expect(await shell.executeText({ script: "true; echo hi; missing-tool" })).toMatchObject({
    exitCode: 127,
  });
  expect(events.filter((event) => event.type === "shell.command")).toEqual([
    { type: "shell.command", name: "true", exitCode: 0 },
    { type: "shell.command", name: "echo", exitCode: 0 },
    { type: "shell.command", name: "missing-tool", exitCode: 127 },
  ]);
  expect(events.at(-1)).toMatchObject({ type: "shell.execution", exitCode: 127 });
  expect(events.at(-1)).not.toHaveProperty("failureCode");

  events.length = 0;
  const bounded = new Shell({
    fileSystem,
    commands: defaultShellCommands,
    limits: { maxCommands: 2 },
    onEvent: (event) => events.push(event),
  });
  expect(await bounded.executeText({ script: "true; true; true" })).toMatchObject({
    exitCode: 1,
  });
  expect(events).toContainEqual({
    type: "shell.limit",
    limit: "maxCommands",
    used: 3,
    max: 2,
  });
  expect(events.at(-1)).toMatchObject({
    type: "shell.execution",
    exitCode: 1,
    failureCode: "E2BIG",
  });
});

it("keeps a throwing shell observer from changing an exit status", async () => {
  const fileSystem = createTestFileSystem();
  const shell = new Shell({
    fileSystem,
    commands: defaultShellCommands,
    onEvent: () => {
      throw new Error("observer failure must not escape");
    },
  });
  expect(await shell.executeText({ script: "echo hi > /out; cat /out" })).toMatchObject({
    exitCode: 0,
    stdout: "hi\n",
    stderr: "",
  });
});

it("charges recursive mutation budgets with a counting query, not a materialized subtree", async () => {
  const fileSystem = createTestFileSystem();
  await fileSystem.writeFile("/tree/nested/leaf", "leaf", { createParents: true });
  await fileSystem.writeFile("/tree/file", "file");

  const calls: string[] = [];
  const observed = new Proxy(fileSystem, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(property));
        return (value as (...rest: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const shell = new Shell({ fileSystem: observed, commands: defaultShellCommands });

  expect(
    await shell.executeText({
      script: "cp -r /tree /copy; mv /copy /moved; rm -r /moved",
    }),
  ).toMatchObject({ exitCode: 0, stderr: "" });

  expect(calls.filter((name) => name === "subtreeSummary")).toHaveLength(3);
  expect(calls).not.toContain("find");
  expect(calls).not.toContain("findPage");
});

it("charges the exact recursive mutation count a counting query reports", async () => {
  const fileSystem = createTestFileSystem();
  await fileSystem.writeFile("/tree/nested/leaf", "leaf", { createParents: true });
  await fileSystem.writeFile("/tree/file", "file");
  // /tree, /tree/file, /tree/nested, /tree/nested/leaf
  expect(fileSystem.subtreeSummary("/tree").entries).toBe(4);

  const denied = new Shell({
    fileSystem,
    commands: defaultShellCommands,
    policy: { maxMutations: 3 },
  });
  expect(await denied.executeText({ script: "rm -r /tree" })).toMatchObject({ exitCode: 1 });
  expect(fileSystem.stat("/tree/file").kind).toBe("file");

  const allowed = new Shell({
    fileSystem,
    commands: defaultShellCommands,
    policy: { maxMutations: 4 },
  });
  expect(await allowed.executeText({ script: "rm -r /tree" })).toMatchObject({
    exitCode: 0,
    stderr: "",
  });
});

it("shares glob, record, and recursive mutation budgets across the execution", async () => {
  const fileSystem = createTestFileSystem();
  await fileSystem.writeFile("/tree/a", "a", { createParents: true });
  await fileSystem.writeFile("/tree/b", "b");
  await fileSystem.writeFile("/tree/c", "c");
  const shell = new Shell({
    fileSystem,
    commands: defaultShellCommands,
    policy: { maxMutations: 2 },
    limits: { maxGlobMatches: 2, maxBufferedRecords: 2, maxLineBytes: 4 },
  });
  expect(await shell.executeText({ script: "printf '%s\n' /tree/*" })).toMatchObject({
    exitCode: 1,
    stdout: "",
  });
  expect(await shell.executeText({ script: "sort", stdin: "a\nb\nc\n" })).toMatchObject({
    exitCode: 1,
    stdout: "",
  });
  expect(await shell.executeText({ script: "grep x", stdin: "xxxxx" })).toMatchObject({
    exitCode: 1,
    stdout: "",
  });
  expect(await shell.executeText({ script: "find /tree -type f" })).toMatchObject({
    exitCode: 1,
    stdout: "",
  });
  expect(await shell.executeText({ script: "find /tree -name '*.missing'" })).toMatchObject({
    exitCode: 1,
    stdout: "",
  });
  expect(await shell.executeText({ script: "tree /tree" })).toMatchObject({
    exitCode: 1,
    stdout: "",
  });
  expect(await shell.executeText({ script: "rm -r /tree" })).toMatchObject({ exitCode: 1 });
  expect(fileSystem.stat("/tree/a").kind).toBe("file");
});

it("sorts signed decimal numeric prefixes without precision loss", async () => {
  const { shell } = createBashHarness();
  const result = await shell.executeText({
    script: "sort -n",
    stdin: "9007199254740993\ninvalid\n2x\n1.5\n1.05\n-0.5\n-10\n9007199254740992\n01\n1\n",
  });
  expect(result).toEqual({
    exitCode: 0,
    stdout: "-10\n-0.5\ninvalid\n01\n1\n1.05\n1.5\n2x\n9007199254740992\n9007199254740993\n",
    stderr: "",
  });
});

it("holds materialized input leases until a multi-file command finishes", async () => {
  const fileSystem = createTestFileSystem();
  await fileSystem.writeFile("/left-large", "a".repeat(900));
  await fileSystem.writeFile("/right-large", "b".repeat(900));
  const shell = new Shell({
    fileSystem,
    commands: defaultShellCommands,
    limits: { maxBufferedBytes: 1_700 },
  });
  await expect(
    shell.executeText({ script: "diff /left-large /right-large" }),
  ).resolves.toMatchObject({ exitCode: 1, stdout: "" });
});

it("charges glob matches cumulatively across words", async () => {
  const fileSystem = createTestFileSystem();
  await fileSystem.writeFile("/g/a", "a", { createParents: true });
  await fileSystem.writeFile("/g/b", "b");
  const shell = new Shell({
    fileSystem,
    commands: defaultShellCommands,
    limits: { maxGlobMatches: 1 },
  });
  await expect(shell.executeText({ script: "printf '%s\\n' /g/a* /g/b*" })).resolves.toMatchObject({
    exitCode: 1,
    stdout: "",
  });
});

it("rejects opaque bodies consistently across body-dependent utilities", async () => {
  const store = new MemoryOpaqueStore();
  const fileSystem = createTestFileSystem({ opaqueStore: store });
  await putOpaque(fileSystem, store, "/opaque", "body");
  await fileSystem.writeFile("/inline", "body\n");
  const shell = new Shell({ fileSystem, commands: defaultShellCommands });
  for (const script of [
    "cat /opaque",
    "head /opaque",
    "tail /opaque",
    "wc /opaque",
    "grep x /opaque",
    "sort /opaque",
    "sed s/x/y/ /opaque",
    "cut -c 1 /opaque",
    "nl /opaque",
    "fold /opaque",
    "cmp /opaque /inline",
    "diff /opaque /inline",
    "patch /inline /opaque",
    "join /opaque /inline",
    "comm /opaque /inline",
  ]) {
    const result = await shell.executeText({ script });
    expect(result.exitCode, script).toBe(1);
    expect(result.stderr, script).toContain("opaque R2 content");
  }
  const digest = await shell.executeText({ script: "sha256sum /opaque" });
  expect(digest).toMatchObject({ exitCode: 1 });
  expect(digest.stderr).toContain("digest is not verified");
});

it("charges every directory created by recursive mkdir before mutating", async () => {
  const fileSystem = createTestFileSystem();
  const shell = new Shell({
    fileSystem,
    commands: defaultShellCommands,
    policy: { maxMutations: 1 },
  });
  expect(await shell.executeText({ script: "mkdir -p /one/two" })).toMatchObject({ exitCode: 1 });
  expect(() => fileSystem.stat("/one")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
});

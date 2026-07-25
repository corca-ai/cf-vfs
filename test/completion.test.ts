import { describe, expect, it } from "vitest";
import { cdCommand, echoCommand } from "../src/shell/commands/core.js";
import { catCommand, mkdirCommand } from "../src/shell/commands/fs.js";
import { lsCommand } from "../src/shell/commands/ls.js";
import { completeShellLine } from "../src/shell/completion.js";
import { InteractiveShell } from "../src/shell/interactive.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

const COMMANDS = [echoCommand, catCommand, lsCommand, mkdirCommand, cdCommand];

async function shell(options: { cwd?: string; pathLookup?: boolean } = {}): Promise<{
  interactive: InteractiveShell;
  fileSystem: ReturnType<typeof createTestFileSystem>;
}> {
  const fileSystem = createTestFileSystem();
  await fileSystem.writeFile("/work/readme.md", "r\n", { createParents: true });
  await fileSystem.writeFile("/work/report.txt", "r\n");
  await fileSystem.mkdir("/work/reports", true);
  await fileSystem.writeFile("/work/other.txt", "o\n");
  const interactive = new InteractiveShell({
    fileSystem,
    commands: COMMANDS,
    cwd: options.cwd ?? "/work",
    env: { HOME: "/work", PROJECT: "cf-vfs" },
    ...(options.pathLookup === true ? { commandResolution: "path" as const } : {}),
  });
  return { interactive, fileSystem };
}

describe("completion", () => {
  it("offers command names only in a command position", async () => {
    const { interactive } = await shell();
    const first = interactive.complete("ec", 2);
    expect(first.candidates).toEqual([{ value: "echo", kind: "command" }]);
    expect(first.start).toBe(0);
    expect(first.end).toBe(2);

    // The same word after a command is a path, which is why `cat re` offers
    // files rather than every command starting with `re`.
    const second = interactive.complete("cat re", 6);
    expect(second.candidates.map((candidate) => candidate.value)).toEqual([
      "readme.md",
      "report.txt",
      "reports/",
    ]);
    expect(second.start).toBe(4);
  });

  it("marks a directory so a client knows not to finish the word", async () => {
    const { interactive } = await shell();
    const result = interactive.complete("ls reports", 10);
    expect(result.candidates).toEqual([{ value: "reports/", kind: "directory" }]);
  });

  it("completes a path under the directory that was typed", async () => {
    const { interactive, fileSystem } = await shell();
    await fileSystem.writeFile("/work/reports/q1.txt", "q\n");
    const result = interactive.complete("cat reports/q", 13);
    // The typed directory is kept verbatim in the candidate, so replacing the
    // word leaves the line the user was writing intact.
    expect(result.candidates).toEqual([{ value: "reports/q1.txt", kind: "path" }]);
    expect(result.start).toBe(4);
  });

  it("offers environment variables after a dollar sign", async () => {
    const { interactive } = await shell();
    expect(interactive.complete("echo $PRO", 9).candidates).toEqual([
      { value: "$PROJECT", kind: "variable" },
    ]);
    expect(interactive.complete("echo ${HO", 9).candidates).toEqual([
      { value: "${HOME}", kind: "variable" },
    ]);
  });

  it("offers the applet path spellings only when PATH lookup is on", async () => {
    const plain = await shell();
    expect(plain.interactive.complete("/bin/ec", 7).candidates).toEqual([]);

    const onPath = await shell({ pathLookup: true });
    expect(onPath.interactive.complete("/bin/ec", 7).candidates).toEqual([
      { value: "/bin/echo", kind: "command" },
    ]);
  });

  it("reports a common prefix computed over everything it found", async () => {
    const { interactive } = await shell();
    const result = interactive.complete("cat re", 6);
    // Typing this much is always safe, whatever the client does next.
    expect(result.commonPrefix).toBe("re");
    expect(result.truncated).toBe(false);
  });

  it("stays bounded on a large directory and says when it stopped early", async () => {
    const fileSystem = createTestFileSystem();
    for (let index = 0; index < 500; index += 1) {
      await fileSystem.writeFile(`/many/file-${String(index).padStart(4, "0")}.txt`, "x", {
        createParents: true,
      });
    }
    const interactive = new InteractiveShell({ fileSystem, commands: COMMANDS, cwd: "/many" });
    const result = interactive.complete("cat file-", 9, { maxCandidates: 10, maxScanned: 64 });
    expect(result.candidates).toHaveLength(10);
    expect(result.truncated).toBe(true);
    // The cap is on entries examined, not only on answers returned: a keystroke
    // cannot walk a directory of any size.
    expect(result.scanned).toBeGreaterThan(0);
    expect(result.scanned).toBeLessThanOrEqual(64);
    // The prefix is still exact for the ones that were dropped.
    expect(result.commonPrefix.startsWith("file-")).toBe(true);
  });

  it("declines a word too long to be worth working on", async () => {
    const { interactive } = await shell();
    const long = "x".repeat(2000);
    const result = interactive.complete(`cat ${long}`, 4 + long.length, { maxWordBytes: 1024 });
    expect(result.candidates).toEqual([]);
    expect(result.scanned).toBe(0);
  });

  it("offers nothing rather than failing for a directory that is not there", async () => {
    const { interactive } = await shell();
    const result = interactive.complete("cat /nope/x", 11);
    expect(result.candidates).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("completes against the session's own working directory", async () => {
    const { interactive } = await shell();
    await interactive.executeText({ script: "mkdir -p /elsewhere && cd /elsewhere" });
    // `cd` moved the session, so completion moved with it.
    expect(interactive.complete("cat re", 6).candidates).toEqual([]);
    expect(interactive.snapshot().cwd).toBe("/elsewhere");
  });

  it("never widens the registry it was built with", async () => {
    const { interactive } = await shell();
    // `grep` is a real applet and is not in this shell.
    expect(interactive.complete("gr", 2).candidates).toEqual([]);
    expect(interactive.complete("", 0).candidates.map((candidate) => candidate.value)).toEqual([
      "cat",
      "cd",
      "echo",
      "ls",
      "mkdir",
    ]);
  });

  it("finds the word under the cursor rather than at the end of the line", async () => {
    const { interactive } = await shell();
    const line = "cat re other.txt";
    const result = interactive.complete(line, 6);
    expect(result.start).toBe(4);
    expect(result.end).toBe(6);
    expect(result.candidates.map((candidate) => candidate.value)).toContain("readme.md");
  });

  it("works without a shell, on any registry and filesystem", async () => {
    const fileSystem = createTestFileSystem();
    await fileSystem.writeFile("/a.txt", "a\n");
    // The library API takes the registry as input; nothing here imports the
    // default one, which is what keeps completion out of a narrow bundle.
    const result = completeShellLine("mycmd ", 6, {
      commands: ["mycmd"],
      fileSystem,
      cwd: "/",
      env: {},
    });
    expect(result.candidates).toEqual([{ value: "a.txt", kind: "path" }]);
  });
});

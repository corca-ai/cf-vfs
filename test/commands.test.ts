import { describe, expect, it } from "vitest";
import { catCommand } from "../src/commands/cat.js";
import { grepCommand } from "../src/commands/grep.js";
import { headCommand } from "../src/commands/head.js";
import { lsCommand } from "../src/commands/ls.js";
import { sedCommand } from "../src/commands/sed.js";
import { tailCommand } from "../src/commands/tail.js";
import { writeCommand } from "../src/commands/write.js";
import { CommandExecutor } from "../src/core/executor.js";
import { createNativeRegexEngine } from "../src/regex/native.js";
import { MemoryFileSystem } from "../src/testing/memory.js";

function createExecutor(): CommandExecutor {
  return new CommandExecutor(
    new MemoryFileSystem({ regexEngine: createNativeRegexEngine() }),
    [catCommand, grepCommand, headCommand, lsCommand, sedCommand, tailCommand, writeCommand],
  );
}

describe("tree-shakable commands", () => {
  it("resolves paths relative to cwd and preserves shell-like text output", async () => {
    const executor = createExecutor();
    expect((await executor.execute({
      command: "write",
      input: { path: "/notes/readme.txt", text: "first\nsecond\nthird\n", createParents: true },
    })).exitCode).toBe(0);

    const listed = await executor.execute({ command: "ls", cwd: "/notes", input: {} });
    expect(listed.stdout).toBe("readme.txt\n");

    const head = await executor.execute({
      command: "head",
      cwd: "/notes",
      input: { path: "readme.txt", lines: 2 },
    });
    expect(head.stdout).toBe("first\nsecond\n");

    const tail = await executor.execute({
      command: "tail",
      cwd: "/notes",
      input: { path: "readme.txt", lines: 1 },
    });
    expect(tail.stdout).toBe("third\n");
  });

  it("searches at the actual regex column and replaces capture groups", async () => {
    const executor = createExecutor();
    await executor.execute({
      command: "write",
      input: { path: "/src/a.ts", text: "const item1 = 1;\nconst item22 = 2;\n", createParents: true },
    });

    const grep = await executor.execute({
      command: "grep",
      input: { pattern: "item\\d+", paths: ["/src"] },
    });
    expect(grep.stdout).toContain("/src/a.ts:1:7:const item1 = 1;");

    const replaced = await executor.execute({
      command: "sed",
      input: {
        path: "/src/a.ts",
        pattern: "item(\\d+)",
        replacement: "value$1",
        global: true,
      },
    });
    expect(replaced.exitCode).toBe(0);
    expect((await executor.execute({ command: "cat", input: { path: "/src/a.ts" } })).stdout)
      .toBe("const value1 = 1;\nconst value22 = 2;\n");
  });

  it("returns shell exit codes and truncates without corrupting UTF-8", async () => {
    const executor = createExecutor();
    expect((await executor.execute({ command: "missing" })).exitCode).toBe(127);
    expect((await executor.execute({ command: "cat", input: { path: "/missing" } })).exitCode)
      .toBe(1);

    await executor.execute({ command: "write", input: { path: "/utf8", text: "가나다" } });
    const result = await executor.execute({
      command: "cat",
      input: { path: "/utf8" },
      maxOutputBytes: 4,
    });
    expect(result.stdout).toBe("가");
    expect(result.truncated).toBe(true);
  });

  it("keeps byte-limited text slices on UTF-8 character boundaries", async () => {
    const executor = createExecutor();
    await executor.execute({ command: "write", input: { path: "/utf8", text: "가나다" } });

    expect((await executor.execute({
      command: "head",
      input: { path: "/utf8", bytes: 4 },
    })).stdout).toBe("가");
    expect((await executor.execute({
      command: "tail",
      input: { path: "/utf8", bytes: 4 },
    })).stdout).toBe("다");
  });
});

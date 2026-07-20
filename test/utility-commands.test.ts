import { describe, expect, it } from "vitest";
import { createCommandExecutor } from "./helpers/executor.js";

describe("namespace and metadata commands", () => {
  it("copies text into a destination directory while preserving its mode", async () => {
    const executor = createCommandExecutor();
    await executor.execute({
      command: "write",
      input: { path: "/source", text: "content", mode: 0o100600 },
    });
    await executor.execute({ command: "mkdir", input: { path: "/destination" } });

    expect((await executor.execute({
      command: "cp",
      input: { from: "/source", to: "/destination" },
    })).exitCode).toBe(0);
    expect((await executor.execute({
      command: "cat",
      input: { path: "/destination/source" },
    })).stdout).toBe("content");
    expect((await executor.execute({
      command: "stat",
      input: { path: "/destination/source" },
    })).data).toMatchObject({ entries: [{ mode: 0o100600 }] });
  });

  it("requires recursive removal for non-empty directories", async () => {
    const executor = createCommandExecutor();
    await executor.execute({
      command: "write",
      input: { path: "/tree/file", text: "content", createParents: true },
    });

    expect((await executor.execute({
      command: "rm",
      input: { path: "/tree" },
    })).data).toEqual({ code: "ENOTEMPTY", path: "/tree" });
    expect((await executor.execute({
      command: "rm",
      input: { path: "/tree", recursive: true },
    })).data).toMatchObject({ results: [{ removed: 2 }] });
    expect((await executor.execute({
      command: "cat",
      input: { path: "/tree/file" },
    })).data).toEqual({ code: "ENOENT", path: "/tree/file" });
  });

  it("reports newline, word, and UTF-8 byte counts", async () => {
    const executor = createCommandExecutor();
    await executor.execute({ command: "write", input: { path: "/text", text: "가 나\nthird" } });

    const result = await executor.execute({ command: "wc", input: { path: "/text" } });

    expect(result.data).toEqual({
      entries: [{ path: "/text", bytes: 13, lines: 1, words: 3 }],
    });
    expect(result.stdout).toBe("       1        3       13 /text\n");
  });

  it("touch creates an empty file with requested metadata", async () => {
    const executor = createCommandExecutor();

    expect((await executor.execute({
      command: "touch",
      input: { path: "/created", modifiedAtMs: 123 },
    })).data).toMatchObject({
      entries: [{ path: "/created", sizeBytes: 0, modifiedAtMs: 123 }],
    });
  });

  it("rmdir accepts only empty directories", async () => {
    const executor = createCommandExecutor();
    await executor.execute({ command: "write", input: { path: "/file", text: "content" } });

    expect((await executor.execute({
      command: "rmdir",
      input: { path: "/file" },
    })).data).toEqual({ code: "ENOTDIR", path: "/file" });

    await executor.execute({ command: "mkdir", input: { path: "/empty" } });
    expect((await executor.execute({
      command: "rmdir",
      input: { path: "/empty" },
    })).exitCode).toBe(0);
  });

  it("filters find results by depth, name, and kind", async () => {
    const executor = createCommandExecutor();
    for (const path of ["/repo/a.ts", "/repo/a.txt", "/repo/deep/b.ts"]) {
      await executor.execute({
        command: "write",
        input: { path, text: path, createParents: true },
      });
    }

    const result = await executor.execute({
      command: "find",
      input: { path: "/repo", name: "*.ts", type: "file", maxDepth: 1 },
    });

    expect(result.stdout).toBe("/repo/a.ts\n");
    expect(result.data).toMatchObject({ entries: [{ path: "/repo/a.ts" }] });
  });
});

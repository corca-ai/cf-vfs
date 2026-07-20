import { describe, expect, it } from "vitest";
import { createCommandExecutor } from "./helpers/executor.js";

describe("filesystem commands", () => {
  it("resolves paths relative to cwd and preserves shell-like output", async () => {
    const executor = createCommandExecutor();
    await executor.execute({
      command: "write",
      input: {
        path: "/notes/readme.txt",
        text: "first\nsecond\nthird\n",
        createParents: true,
      },
    });

    expect((await executor.execute({ command: "ls", cwd: "/notes", input: {} })).stdout)
      .toBe("readme.txt\n");
    expect((await executor.execute({ command: "pwd", cwd: "/notes", input: {} })).stdout)
      .toBe("/notes\n");
    expect((await executor.execute({
      command: "head",
      cwd: "/notes",
      input: { path: "readme.txt", lines: 2 },
    })).stdout).toBe("first\nsecond\n");
    expect((await executor.execute({
      command: "tail",
      cwd: "/notes",
      input: { path: "readme.txt", lines: 1 },
    })).stdout).toBe("third\n");
  });

  it("reports regex matches at their actual columns", async () => {
    const executor = createCommandExecutor();
    await executor.execute({
      command: "write",
      input: {
        path: "/src/a.ts",
        text: "const item1 = 1;\nconst item22 = 2;\n",
        createParents: true,
      },
    });

    const grep = await executor.execute({
      command: "grep",
      input: { pattern: "item\\d+", paths: ["/src"] },
    });
    expect(grep.stdout).toContain("/src/a.ts:1:7:const item1 = 1;");
    expect(await executor.execute({
      command: "grep",
      input: { pattern: "missing", paths: ["/src"] },
    })).toMatchObject({ exitCode: 1, stdout: "", data: { matches: [] } });
  });

  it("expands capture groups when replacing text", async () => {
    const executor = createCommandExecutor();
    await executor.execute({
      command: "write",
      input: {
        path: "/src/a.ts",
        text: "const item1 = 1;\nconst item22 = 2;\n",
        createParents: true,
      },
    });

    await executor.execute({
      command: "sed",
      input: {
        path: "/src/a.ts",
        pattern: "item(\\d+)",
        replacement: "value$1",
        global: true,
      },
    });
    expect((await executor.execute({ command: "cat", input: { path: "/src/a.ts" } })).stdout)
      .toBe("const value1 = 1;\nconst value22 = 2;\n");
  });

  it("keeps byte-limited text slices on UTF-8 character boundaries", async () => {
    const executor = createCommandExecutor();
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

  it("supports explicit create and replace write dispositions", async () => {
    const executor = createCommandExecutor();
    await executor.execute({
      command: "write",
      input: { path: "/source", text: "new", disposition: "create" },
    });

    expect((await executor.execute({
      command: "write",
      input: { path: "/source", text: "duplicate", disposition: "create" },
    })).data).toEqual({ code: "EEXIST", path: "/source" });
    expect((await executor.execute({
      command: "write",
      input: { path: "/missing", text: "missing", disposition: "replace" },
    })).data).toEqual({ code: "ENOENT", path: "/missing" });
  });

  it("requires opt-in replacement when moving over a destination", async () => {
    const executor = createCommandExecutor();
    await executor.execute({ command: "write", input: { path: "/source", text: "new" } });

    await executor.execute({ command: "write", input: { path: "/target", text: "old" } });
    expect((await executor.execute({
      command: "mv",
      input: { from: "/source", to: "/target" },
    })).data).toEqual({ code: "EEXIST", path: "/target" });

    const moved = await executor.execute({
      command: "mv",
      input: { from: "/source", to: "/target", replace: true },
    });
    expect(moved.data).toMatchObject({ from: "/source", to: "/target", replaced: true });
    expect((await executor.execute({ command: "cat", input: { path: "/target" } })).stdout)
      .toBe("new");
  });

  it("preserves trailing-slash directory intent", async () => {
    const executor = createCommandExecutor();
    await executor.execute({
      command: "write",
      input: { path: "/dir/file", text: "content", createParents: true },
    });

    expect((await executor.execute({
      command: "cat",
      input: { path: "/dir/file/" },
    })).data).toEqual({ code: "ENOTDIR", path: "/dir/file" });
    expect((await executor.execute({
      command: "ls",
      input: { path: "//dir///" },
    })).stdout).toBe("file\n");
    expect((await executor.execute({
      command: "write",
      input: { path: "/missing/", text: "must not be created" },
    })).data).toEqual({ code: "ENOENT", path: "/missing" });
  });

  it("renders a bounded workspace tree", async () => {
    const executor = createCommandExecutor();
    await executor.execute({
      command: "write",
      input: { path: "/repo/a.txt", text: "one\ntwo\n", createParents: true },
    });
    await executor.execute({
      command: "write",
      input: { path: "/repo/sub/b.txt", text: "one\nthree\n", createParents: true },
    });

    const tree = await executor.execute({ command: "tree", input: { path: "/repo" } });
    expect(tree.stdout).toBe("/repo\n  a.txt\n  sub\n    b.txt\n");
    expect(tree.data).toMatchObject({ directories: 1, files: 2, truncated: false });
  });

  it("sums workspace usage from file metadata", async () => {
    const executor = createCommandExecutor();
    await executor.execute({
      command: "write",
      input: { path: "/repo/a.txt", text: "one\ntwo\n", createParents: true },
    });
    await executor.execute({
      command: "write",
      input: { path: "/repo/sub/b.txt", text: "one\nthree\n", createParents: true },
    });

    const du = await executor.execute({ command: "du", input: { path: "/repo" } });
    expect(du.stdout).toBe("18\t/repo\n");
    expect(du.data).toMatchObject({ entries: [{ files: 2, sizeBytes: 18 }] });
  });

  it("produces a line-oriented diff for changed files", async () => {
    const executor = createCommandExecutor();
    await executor.execute({ command: "write", input: { path: "/before", text: "one\ntwo\n" } });
    await executor.execute({ command: "write", input: { path: "/after", text: "one\nthree\n" } });

    const diff = await executor.execute({
      command: "diff",
      input: { from: "/before", to: "/after" },
    });
    expect(diff.exitCode).toBe(1);
    expect(diff.stdout).toContain("@@ -2,1 +2,1 @@\n-two\n+three\n");
    expect(diff.data).toMatchObject({ equal: false, changes: 2 });
  });

  it("validates untrusted command input before constructing options", async () => {
    const executor = createCommandExecutor();
    const invalidRequests = [
      { command: "write", input: { path: "/file", text: "x", disposition: "append" } },
      { command: "find", input: { path: "/", type: "symlink" } },
      { command: "cut", input: { text: "a:b", delimiter: ":", fields: [1, "2"] } },
      { command: "head", input: { path: "/file", lines: 1, bytes: 1 } },
    ];

    for (const request of invalidRequests) {
      expect(await executor.execute(request)).toMatchObject({
        exitCode: 2,
        data: { code: "EINVAL", path: null },
      });
    }
  });
});

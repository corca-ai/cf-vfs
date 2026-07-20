import { describe, expect, it } from "vitest";
import { createCommandExecutor } from "./helpers/executor.js";

describe("filesystem-oriented extended commands", () => {
  it("uses exit status one for a false test predicate without treating it as an error", async () => {
    const executor = createCommandExecutor();
    await executor.execute({ command: "write", input: { path: "/present", text: "value" } });

    expect(await executor.execute({
      command: "test",
      input: { path: "/present", predicate: "nonempty" },
    })).toMatchObject({ exitCode: 0, data: { matched: true, path: "/present" } });
    expect(await executor.execute({
      command: "test",
      input: { path: "/missing" },
    })).toMatchObject({
      exitCode: 1,
      stderr: "",
      data: { matched: false, path: "/missing", stat: null },
    });
  });

  it("tees bounded stdin to multiple files and appends to an existing file", async () => {
    const executor = createCommandExecutor();

    expect(await executor.execute({
      command: "tee",
      stdin: "alpha\n",
      input: { paths: ["/one", "/two"] },
    })).toMatchObject({ exitCode: 0, stdout: "alpha\n" });
    await executor.execute({
      command: "tee",
      stdin: "beta\n",
      input: { paths: ["/one"], append: true },
    });

    expect((await executor.execute({ command: "cat", input: { path: "/one" } })).stdout)
      .toBe("alpha\nbeta\n");
    expect((await executor.execute({ command: "cat", input: { path: "/two" } })).stdout)
      .toBe("alpha\n");
  });

  it("changes permission metadata without losing the regular-file kind bits", async () => {
    const executor = createCommandExecutor();
    await executor.execute({
      command: "write",
      input: { path: "/private", text: "secret", mode: 0o100644 },
    });

    const changed = await executor.execute({
      command: "chmod",
      input: { path: "/private", mode: 0o600 },
    });

    expect(changed.data).toMatchObject({ entries: [{ mode: 0o100600, kind: "file" }] });
  });

  it("provides lexical basename and dirname plus canonical realpath", async () => {
    const executor = createCommandExecutor();
    await executor.execute({
      command: "write",
      input: { path: "/repo/file.ts", text: "value", createParents: true },
    });

    expect((await executor.execute({
      command: "basename",
      input: { path: "/repo/file.ts/", suffix: ".ts" },
    })).stdout).toBe("file\n");
    expect((await executor.execute({
      command: "dirname",
      input: { path: "repo/file.ts" },
    })).stdout).toBe("repo\n");
    expect((await executor.execute({
      command: "realpath",
      cwd: "/repo",
      input: { path: "./sub/../file.ts" },
    })).stdout).toBe("/repo/file.ts\n");
  });

  it("reports the first differing byte and line through cmp exit status", async () => {
    const executor = createCommandExecutor();
    await executor.execute({ command: "write", input: { path: "/left", text: "one\nsame" } });
    await executor.execute({ command: "write", input: { path: "/right", text: "one\ndiff" } });

    expect(await executor.execute({
      command: "cmp",
      input: { from: "/left", to: "/right" },
    })).toMatchObject({
      exitCode: 1,
      data: { equal: false, firstDifferenceByte: 5, firstDifferenceLine: 2 },
    });
    expect(await executor.execute({
      command: "cmp",
      input: { from: "/left", to: "/left" },
    })).toMatchObject({ exitCode: 0, stdout: "", data: { equal: true } });
  });

  it("applies a single-file unified patch under an implicit revision guard", async () => {
    const executor = createCommandExecutor();
    await executor.execute({ command: "write", input: { path: "/doc", text: "one\ntwo\n" } });
    const patch = "--- /doc\n+++ /doc\n@@ -2,1 +2,1 @@\n-two\n+changed\n";

    expect(await executor.execute({
      command: "patch",
      input: { path: "/doc", patch },
    })).toMatchObject({
      exitCode: 0,
      data: { hunks: 1, additions: 1, deletions: 1, revision: 2 },
    });
    expect((await executor.execute({ command: "cat", input: { path: "/doc" } })).stdout)
      .toBe("one\nchanged\n");

    expect(await executor.execute({
      command: "patch",
      input: { path: "/doc", patch },
    })).toMatchObject({ exitCode: 1, data: { code: "EREVISION" } });
  });

  it("creates unique temporary files and directories with private default modes", async () => {
    const executor = createCommandExecutor();
    const first = await executor.execute({ command: "mktemp", input: {} });
    const second = await executor.execute({ command: "mktemp", input: {} });
    const directory = await executor.execute({ command: "mktemp", input: { directory: true } });
    const firstPath = (first.data as { path: string }).path;
    const secondPath = (second.data as { path: string }).path;

    expect(firstPath).toMatch(/^\/tmp\/tmp\.[0-9a-f]{8}$/u);
    expect(secondPath).not.toBe(firstPath);
    expect(first.data).toMatchObject({ stat: { kind: "file", mode: 0o100600 } });
    expect(directory.data).toMatchObject({ stat: { kind: "directory", mode: 0o040700 } });
  });
});

describe("bounded text combination commands", () => {
  it("calculates SHA-256 for UTF-8 file bytes", async () => {
    const executor = createCommandExecutor();
    await executor.execute({ command: "write", input: { path: "/abc", text: "abc" } });

    expect(await executor.execute({ command: "sha256sum", input: { path: "/abc" } }))
      .toMatchObject({
        exitCode: 0,
        stdout: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  /abc\n",
      });
  });

  it("pastes inputs in parallel and serial forms", async () => {
    const executor = createCommandExecutor();

    expect((await executor.execute({
      command: "paste",
      input: { texts: ["a\nb\n", "1\n2\n"], delimiter: ":" },
    })).stdout).toBe("a:1\nb:2\n");
    expect((await executor.execute({
      command: "paste",
      input: { texts: ["a\nb\n", "1\n2\n"], delimiter: ":", serial: true },
    })).stdout).toBe("a:b\n1:2\n");
  });

  it("compares sorted inputs with stable three-column comm output", async () => {
    const result = await createCommandExecutor().execute({
      command: "comm",
      input: { left: "a\nc\n", right: "b\nc\n" },
    });

    expect(result.stdout).toBe("a\n\tb\n\t\tc\n");
    expect(result.data).toEqual({ leftOnly: 1, rightOnly: 1, common: 1 });
  });

  it("joins duplicate keys and optionally retains unpaired rows", async () => {
    const result = await createCommandExecutor().execute({
      command: "join",
      input: {
        left: "1 alice\n2 bob\n",
        right: "1 admin\n3 guest\n",
        unpaired: "both",
      },
    });

    expect(result.stdout).toBe("1 alice admin\n2 bob\n3 guest\n");
    expect(result.data).toEqual({ rows: 3, matchedPairs: 1 });

    expect(await createCommandExecutor().execute({
      command: "join",
      input: { left: "1 a\n1 b\n", right: "1 x\n1 y\n", maxRows: 3 },
    })).toMatchObject({ exitCode: 1, data: { code: "E2BIG" } });
  });

  it("folds by Unicode code points and preserves final newline state", async () => {
    const executor = createCommandExecutor();

    expect((await executor.execute({
      command: "fold",
      stdin: "가나다라마\n",
      input: { width: 3 },
    })).stdout).toBe("가나다\n라마\n");
    expect((await executor.execute({
      command: "fold",
      stdin: "one two three",
      input: { width: 7, spaces: true },
    })).stdout).toBe("one \ntwo \nthree");
  });
});

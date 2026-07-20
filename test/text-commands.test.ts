import { describe, expect, it } from "vitest";
import { createCommandExecutor } from "./helpers/executor.js";

describe("text transform commands", () => {
  it("sorts numerically while preserving the final newline", async () => {
    const result = await createCommandExecutor().execute({
      command: "sort",
      stdin: "10\n2\n1\n",
      input: { numeric: true },
    });

    expect(result.stdout).toBe("1\n2\n10\n");
  });

  it("uses explicit text in preference to stdin", async () => {
    const result = await createCommandExecutor().execute({
      command: "sort",
      stdin: "ignored",
      input: { text: "b\na", reverse: true },
    });

    expect(result.stdout).toBe("b\na");
  });

  it("keeps case-insensitive ties stable when reversing groups", async () => {
    const result = await createCommandExecutor().execute({
      command: "sort",
      stdin: "A\na\nB\n",
      input: { ignoreCase: true, reverse: true },
    });

    expect(result.stdout).toBe("B\nA\na\n");
  });

  it("counts adjacent Unicode lines with uniq", async () => {
    const result = await createCommandExecutor().execute({
      command: "uniq",
      stdin: "가\n가\n나\n",
      input: { count: true },
    });

    expect(result.stdout).toBe("      2 가\n      1 나\n");
  });

  it("selects cut fields in requested order and preserves delimiter-free lines", async () => {
    const result = await createCommandExecutor().execute({
      command: "cut",
      stdin: "a:b:c\nplain\n",
      input: { delimiter: ":", fields: [3, 1] },
    });

    expect(result.stdout).toBe("c:a\nplain\n");
  });

  it("translates Unicode code points", async () => {
    const result = await createCommandExecutor().execute({
      command: "tr",
      stdin: "가나다 가",
      input: { from: "가나", to: "AB" },
    });

    expect(result.stdout).toBe("AB다 A");
  });

  it("numbers non-empty lines by default", async () => {
    const result = await createCommandExecutor().execute({
      command: "nl",
      stdin: "first\n\nthird",
      input: { width: 2, separator: ":" },
    });

    expect(result.stdout).toBe(" 1:first\n  :\n 2:third");
  });

  it("applies the input byte limit to explicit text", async () => {
    const result = await createCommandExecutor().execute({
      command: "sort",
      maxInputBytes: 3,
      input: { text: "가a" },
    });

    expect(result).toMatchObject({ exitCode: 1, data: { code: "E2BIG", path: null } });
  });
});

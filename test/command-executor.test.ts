import { describe, expect, it } from "vitest";
import type { CommandDefinition, ExecuteRequest } from "../src/core/command.js";
import { VfsError, type VfsErrorCode } from "../src/core/errors.js";
import { CommandExecutor } from "../src/core/executor.js";
import { MemoryFileSystem } from "../src/testing/memory.js";

const payloadCommand: CommandDefinition = {
  name: "payload",
  execute(context, input) {
    return {
      stdout: context.stdin.length > 0 ? context.stdin : "가나다",
      data: { input },
    };
  },
};

function createExecutor(...commands: CommandDefinition[]): CommandExecutor {
  return new CommandExecutor(new MemoryFileSystem(), commands);
}

function throwingCommand(code: VfsErrorCode): CommandDefinition {
  return {
    name: `throw-${code}`,
    execute() {
      throw new VfsError(code, `failed with ${code}`, "/target");
    },
  };
}

describe("CommandExecutor", () => {
  it("rejects duplicate command names during construction", () => {
    expect(() => createExecutor(payloadCommand, payloadCommand)).toThrowError(
      "duplicate command: payload",
    );
  });

  it("returns the shell command-not-found contract", async () => {
    const result = await createExecutor().execute({ command: "missing", cwd: "/repo/../work" });

    expect(result).toEqual({
      command: "missing",
      cwd: "/work",
      exitCode: 127,
      stdout: "",
      stderr: "missing: command not found",
      data: null,
      truncated: false,
    });
  });

  it("projects command payloads into both, structured, and text output modes", async () => {
    const executor = createExecutor(payloadCommand);

    expect(await executor.execute({ command: "payload", input: "both" })).toMatchObject({
      stdout: "가나다",
      data: { input: "both" },
    });
    expect(await executor.execute({
      command: "payload",
      input: "structured",
      output: "structured",
    })).toMatchObject({ stdout: "", data: { input: "structured" } });
    expect(await executor.execute({
      command: "payload",
      input: "text",
      output: "text",
    })).toMatchObject({ stdout: "가나다", data: null });
  });

  it("truncates output without emitting partial UTF-8 characters", async () => {
    const result = await createExecutor(payloadCommand).execute({
      command: "payload",
      maxOutputBytes: 4,
    });

    expect(result).toMatchObject({ stdout: "가", truncated: true });
  });

  it("accepts stdin at the byte boundary and rejects the next byte", async () => {
    const executor = createExecutor(payloadCommand);

    expect(await executor.execute({
      command: "payload",
      stdin: "가",
      maxInputBytes: 3,
    })).toMatchObject({ exitCode: 0, stdout: "가" });
    expect(await executor.execute({
      command: "payload",
      stdin: "가a",
      maxInputBytes: 3,
    })).toMatchObject({
      exitCode: 1,
      data: { code: "E2BIG", path: null },
    });
  });

  it.each([
    ["non-string stdin", { command: "payload", stdin: 42 }],
    ["negative output limit", { command: "payload", maxOutputBytes: -1 }],
    ["unknown output mode", { command: "payload", output: "json" }],
  ])("rejects %s at the untrusted request boundary", async (_case, untrustedRequest) => {
    const result = await createExecutor(payloadCommand).execute(
      untrustedRequest as unknown as ExecuteRequest,
    );

    expect(result).toMatchObject({
      exitCode: 2,
      data: { code: "EINVAL", path: null },
    });
  });

  it("maps invalid arguments to exit 2 and filesystem failures to exit 1", async () => {
    const invalid = throwingCommand("EINVAL");
    const missing = throwingCommand("ENOENT");
    const executor = createExecutor(invalid, missing);

    expect(await executor.execute({ command: invalid.name })).toMatchObject({
      exitCode: 2,
      data: { code: "EINVAL", path: "/target" },
    });
    expect(await executor.execute({ command: missing.name })).toMatchObject({
      exitCode: 1,
      data: { code: "ENOENT", path: "/target" },
    });
  });

  it("does not hide unexpected command failures", async () => {
    const unexpected: CommandDefinition = {
      name: "unexpected",
      execute() {
        throw new Error("programmer error");
      },
    };

    await expect(createExecutor(unexpected).execute({ command: unexpected.name }))
      .rejects.toThrowError("programmer error");
  });
});

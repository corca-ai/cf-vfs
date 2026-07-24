import { describe, expect, it } from "vitest";
import { VfsError } from "../src/core/errors.js";
import {
  InteractiveInputBuffer,
  InteractiveShell,
} from "../src/shell/interactive.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { MemoryFileSystem } from "../src/vfs/memory.js";

function createInteractiveShell(): {
  fileSystem: MemoryFileSystem;
  shell: InteractiveShell;
} {
  const fileSystem = new MemoryFileSystem();
  return {
    fileSystem,
    shell: new InteractiveShell({
      fileSystem,
      commands: defaultShellCommands,
      env: { HOME: "/" },
    }),
  };
}

describe("InteractiveShell", () => {
  it("preserves cwd, variables, functions, options, and status between source units", async () => {
    const { shell } = createInteractiveShell();

    await expect(shell.runText({
      script: "mkdir -p /repo; cd /repo; NAME=world; greet() { printf 'hello %s' \"$NAME\"; }",
    })).resolves.toMatchObject({ exitCode: 0, stderr: "" });
    await expect(shell.runText({ script: "greet > greeting.txt; false" })).resolves.toMatchObject({
      exitCode: 1,
      stderr: "",
    });
    await expect(shell.runText({
      script: "printf '%s:%s:%s:' \"$PWD\" \"$NAME\" \"$?\"; cat greeting.txt",
    })).resolves.toEqual({
      exitCode: 0,
      stdout: "/repo:world:1:hello world",
      stderr: "",
    });

    expect(shell.cwd).toBe("/repo");
    expect(shell.snapshot()).toMatchObject({
      cwd: "/repo",
      env: { NAME: "world", PWD: "/repo" },
      lastExitCode: 0,
    });
  });

  it("keeps inherited execution methods session-aware and rejects per-unit context", async () => {
    const { shell } = createInteractiveShell();

    await shell.executeText({ script: "VALUE=kept" });
    await expect(shell.executeText({ script: "printf '%s' \"$VALUE\"" })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "kept",
    });
    await expect(shell.executeText({ script: "true", cwd: "/elsewhere" })).rejects.toMatchObject({
      code: "EINVAL",
      message: "interactive execution context belongs in the InteractiveShell constructor",
    });
  });

  it("clears unit-local flow while preserving shell options", async () => {
    const { fileSystem, shell } = createInteractiveShell();

    await expect(shell.runText({
      script: "set -e; false; touch /not-created",
    })).resolves.toMatchObject({ exitCode: 1 });
    await expect(shell.runText({ script: "printf resumed" })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "resumed",
    });
    await expect(shell.runText({
      script: "false; touch /still-not-created",
    })).resolves.toMatchObject({ exitCode: 1 });

    expect(() => fileSystem.stat("/not-created")).toThrowError(VfsError);
    expect(() => fileSystem.stat("/still-not-created")).toThrowError(VfsError);
    expect(shell.snapshot().errexit).toBe(true);
  });

  it("records a syntax status and remains usable", async () => {
    const { shell } = createInteractiveShell();

    await expect(shell.runText({ script: "if" })).resolves.toMatchObject({
      exitCode: 2,
      stderr: expect.stringContaining("requires a non-empty command list"),
    });
    await expect(shell.runText({ script: "printf '%s' \"$?\"" })).resolves.toEqual({
      exitCode: 0,
      stdout: "2",
      stderr: "",
    });
  });

  it("rejects overlapping executions without closing the session", async () => {
    const { shell } = createInteractiveShell();
    const input = new ReadableStream<Uint8Array>({ start() {} });
    const execution = shell.runStream({ script: "cat", stdin: input });

    expect(() => shell.runStream({ script: "true" })).toThrowError(
      expect.objectContaining({
        code: "EAGAIN",
        message: "interactive shell already has an active execution",
      }),
    );

    execution.cancel();
    await execution.completed;
    await expect(shell.runText({ script: "printf reused" })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "reused",
    });
  });

  it("closes after exit", async () => {
    const { shell } = createInteractiveShell();

    await expect(shell.runText({ script: "exit 7" })).resolves.toMatchObject({ exitCode: 7 });
    expect(shell.isClosed).toBe(true);
    await expect(shell.runText({ script: "true" })).rejects.toMatchObject({
      code: "EINVAL",
      message: "interactive shell is closed",
    });
  });
});

describe("InteractiveInputBuffer", () => {
  it("collects compound commands, quotes, and line continuations", () => {
    const input = new InteractiveInputBuffer();

    expect(input.push("if true; then")).toEqual({ status: "incomplete" });
    expect(input.push("printf '%s' \"yes\"")).toEqual({ status: "incomplete" });
    expect(input.push("fi")).toEqual({
      status: "ready",
      source: "if true; then\nprintf '%s' \"yes\"\nfi\n",
    });

    expect(input.push("printf '%s' 'two")).toEqual({ status: "incomplete" });
    expect(input.push("lines'")).toEqual({
      status: "ready",
      source: "printf '%s' 'two\nlines'\n",
    });

    expect(input.push("printf one \\")).toEqual({ status: "incomplete" });
    expect(input.push("two")).toEqual({
      status: "ready",
      source: "printf one \\\ntwo\n",
    });

    expect(input.push("# a comment ending in \\")).toEqual({
      status: "ready",
      source: "# a comment ending in \\\n",
    });

    expect(input.push("cat <<EOF")).toEqual({ status: "incomplete" });
    expect(input.push("body")).toEqual({ status: "incomplete" });
    expect(input.push("EOF")).toEqual({
      status: "ready",
      source: "cat <<EOF\nbody\nEOF\n",
    });
  });

  it("submits complete syntax errors instead of waiting for more input", () => {
    const input = new InteractiveInputBuffer();

    expect(input.push("if; then")).toEqual({
      status: "ready",
      source: "if; then\n",
    });
    expect(input.push("printf '%s' \"$(true &&)\"")).toEqual({
      status: "ready",
      source: "printf '%s' \"$(true &&)\"\n",
    });
  });

  it("can discard pending source", () => {
    const input = new InteractiveInputBuffer();
    expect(input.push("while true; do")).toEqual({ status: "incomplete" });
    expect(input.hasPendingSource).toBe(true);
    input.clear();
    expect(input.hasPendingSource).toBe(false);
    expect(input.push("printf reset")).toEqual({
      status: "ready",
      source: "printf reset\n",
    });
  });
});

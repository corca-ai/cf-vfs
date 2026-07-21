import { describe, expect, it } from "vitest";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { defineCommand, writeText } from "../src/shell/commands/helpers.js";
import { Shell } from "../src/shell/shell.js";
import { MemoryFileSystem } from "../src/vfs/memory.js";
import { putOpaque } from "../src/vfs/opaque.js";
import { readAllBytes } from "../src/vfs/streams.js";
import { MemoryOpaqueStore } from "../src/testing/opaque-store.js";
import { createBashHarness } from "./helpers/bash.js";

describe("stream-first shell runtime", () => {
  it("keeps the per-edge pipeline limit at or below 8 MiB", () => {
    expect(() => new Shell({
      fileSystem: new MemoryFileSystem(),
      commands: defaultShellCommands,
      limits: { maxPipelineBytes: 8 * 1024 * 1024 + 1 },
    })).toThrowError(expect.objectContaining({ code: "EINVAL" }));
  });

  it("treats printf %b arguments as escaped data and reports invalid test integers as usage errors", async () => {
    const { shell } = createBashHarness();
    expect(await shell.executeText({ script: "printf '%b\\n' '%s'" })).toMatchObject({
      exitCode: 0,
      stdout: "%s\n",
    });
    expect(await shell.executeText({ script: "test 1 -eq x" })).toMatchObject({
      exitCode: 2,
      stderr: expect.stringContaining("integer expression expected"),
    });
  });

  it("keeps ! inside command words and follows Bash positional expansion rules", async () => {
    const bang = defineCommand("!echo", async (_context, argv, fds) => {
      await writeText(fds[1], `${argv.join("|")}\n`);
      return 0;
    });
    const { shell } = createBashHarness({ extraCommands: [bang] });
    const result = await shell.executeText({
      script: `!echo $10 "\${10}" "$@"; printf '<%s>\n' $FIELDS`,
      args: ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"],
      env: { FIELDS: "left right" },
    });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "one0|ten|one|two|three|four|five|six|seven|eight|nine|ten\n<left>\n<right>\n",
      stderr: "",
    });
  });

  it("runs a backpressured find/sort pipeline into an atomic redirection", async () => {
    const { fileSystem, shell } = createBashHarness();
    const result = await shell.executeText({
      script: `mkdir -p src; printf b > src/b.ts; printf a > src/a.ts; find src -name '*.ts' | sort > files.txt; cat files.txt`,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("/src/a.ts\n/src/b.ts\n");
    expect(new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/files.txt").stream, 1024)))
      .toBe("/src/a.ts\n/src/b.ts\n");
  });

  it("preserves arbitrary bytes through cat without UTF-8 materialization", async () => {
    const { fileSystem, shell } = createBashHarness();
    await fileSystem.writeFile("/binary", new Uint8Array([0xff, 0, 1, 2]));
    const execution = shell.executeStream({ script: "cat /binary" });
    const [stdout, stderr, status] = await Promise.all([
      readAllBytes(execution.stdout, 16),
      readAllBytes(execution.stderr, 16),
      execution.completed,
    ]);
    expect([...stdout]).toEqual([0xff, 0, 1, 2]);
    expect(stderr.byteLength).toBe(0);
    expect(status.exitCode).toBe(0);
  });

  it("commits normal-close redirections even for a non-zero command", async () => {
    const { fileSystem, shell } = createBashHarness();
    await fileSystem.writeFile("/file", "old");
    const result = await shell.executeText({ script: "false > /file" });
    expect(result.exitCode).toBe(1);
    expect((await fileSystem.stat("/file")).sizeBytes).toBe(0);
  });

  it("honors left-to-right fd duplication", async () => {
    const emit = defineCommand("emit", async (_context, _argv, fds) => {
      await Promise.all([writeText(fds[1], "out\n"), writeText(fds[2], "err\n")]);
      return 0;
    });
    const { fileSystem, shell } = createBashHarness({ extraCommands: [emit] });
    const result = await shell.executeText({
      script: "emit > /both 2>&1; emit 2>&1 > /stdout",
    });
    expect(result.stdout).toBe("err\n");
    expect(result.stderr).toBe("");
    expect(new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/both").stream, 32)))
      .toBe("out\nerr\n");
    expect(new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/stdout").stream, 32)))
      .toBe("out\n");
  });

  it("preflights redirection parents before running the command", async () => {
    const { fileSystem, shell } = createBashHarness();
    const result = await shell.executeText({ script: "touch /side-effect > /missing/output" });
    expect(result).toMatchObject({ exitCode: 1 });
    expect(() => fileSystem.stat("/side-effect")).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("uses write capability rather than read capability to inspect destinations", async () => {
    const fileSystem = new MemoryFileSystem();
    await fileSystem.writeFile("/input/a", "body", { createParents: true });
    await fileSystem.mkdir("/output");
    const shell = new Shell({
      fileSystem,
      commands: defaultShellCommands,
      policy: { readRoots: ["/input"], writeRoots: ["/output"] },
    });
    const result = await shell.executeText({
      script: "printf direct > /output/new; cp /input/a /output/copy",
    });
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/output/new").stream, 16)))
      .toBe("direct");
    expect(new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/output/copy").stream, 16)))
      .toBe("body");
  });

  it("aborts an opened atomic target if a later redirection cannot be applied", async () => {
    const { fileSystem, shell } = createBashHarness();
    await fileSystem.writeFile("/target", "old");
    await fileSystem.mkdir("/directory");
    const result = await shell.executeText({ script: "printf new > /target > /directory" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("is a directory");
    expect(new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/target").stream, 16)))
      .toBe("old");
  });

  it("reports an atomic redirection close failure instead of discarding it", async () => {
    const mutateTarget = defineCommand("mutate-target", async (context, _argv, fds) => {
      await writeText(fds[1], "new");
      await context.fileSystem.touch("/target");
      return 0;
    });
    const { fileSystem, shell } = createBashHarness({ extraCommands: [mutateTarget] });
    await fileSystem.writeFile("/target", "old");
    const result = await shell.executeText({ script: "mutate-target > /target" });
    expect(result).toMatchObject({ exitCode: 1 });
    expect(result.stderr).toContain("mutation token");
    expect(new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/target").stream, 16)))
      .toBe("old");
  });

  it("keeps parent shell state for ordinary builtins but clones pipeline stages", async () => {
    const { shell } = createBashHarness();
    const result = await shell.executeText({
      script: "mkdir -p /work/sub; cd /work; pwd; cd /work/sub | cat; pwd",
    });
    expect(result.stdout).toBe("/work\n/work\n");
  });

  it("runs compound groups, conditionals, loops, and case clauses", async () => {
    const { shell } = createBashHarness();
    const result = await shell.executeText({
      script: [
        "X=outer",
        "{ X=group; }",
        "printf '%s|' \"$X\"",
        "(X=subshell; printf '%s|' \"$X\")",
        "printf '%s|' \"$X\"",
        "if false; then printf no; elif true; then printf elif; else printf no; fi",
        "for item in a b c; do test \"$item\" = b && continue; printf ':%s' \"$item\"; test \"$item\" = c && break; done",
        "count=0",
        "while ((count < 2)); do ((count += 1)); done",
        "until ((count >= 3)); do ((count++)); done",
        "case \"$count\" in 1|2) printf no ;; 3) printf ':case' ;; *) printf no ;; esac",
      ].join("; "),
    });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "group|subshell|group|elif:a:c:case",
      stderr: "",
    });
  });

  it("shares loop, recursion, substitution, and parser nesting limits", async () => {
    const fileSystem = new MemoryFileSystem();
    const loopLimited = new Shell({
      fileSystem,
      commands: defaultShellCommands,
      limits: { maxLoopIterations: 2 },
    });
    expect(await loopLimited.executeText({ script: "while true; do :; done" }))
      .toMatchObject({ exitCode: 1, stdout: "" });

    const recursive = new Shell({
      fileSystem,
      commands: defaultShellCommands,
      limits: { maxFunctionDepth: 2 },
    });
    expect(await recursive.executeText({ script: "recurse() { recurse; }; recurse" }))
      .toMatchObject({ exitCode: 1 });

    const substitution = new Shell({
      fileSystem,
      commands: defaultShellCommands,
      limits: { maxCommandSubstitutionBytes: 4 },
    });
    expect(await substitution.executeText({ script: "printf '%s' \"$(printf 12345)\"" }))
      .toMatchObject({ exitCode: 1, stdout: "" });

    const bufferedSubstitution = new Shell({
      fileSystem,
      commands: defaultShellCommands,
      limits: { maxBufferedBytes: 4 },
    });
    expect(await bufferedSubstitution.executeText({ script: "printf '%s' \"$(printf 12345)\"" }))
      .toMatchObject({ exitCode: 1, stdout: "" });

    const nested = new Shell({
      fileSystem,
      commands: defaultShellCommands,
      limits: { maxNestingDepth: 1 },
    });
    expect(await nested.executeText({ script: "(true)" })).toMatchObject({ exitCode: 1 });
    expect(await nested.executeText({ script: "printf '%s' \"$((- - 1))\"" }))
      .toMatchObject({ exitCode: 1 });
  });

  it("enforces command and path capabilities below utilities", async () => {
    const fileSystem = new MemoryFileSystem();
    await fileSystem.writeFile("/allowed/input", "ok", { createParents: true });
    await fileSystem.writeFile("/secret", "no");
    const shell = new Shell({
      fileSystem,
      commands: defaultShellCommands,
      policy: {
        readRoots: ["/allowed"],
        writeRoots: ["/allowed"],
        allowedCommands: ["cat", "printf"],
      },
    });
    expect(await shell.executeText({ script: "cat /allowed/input" })).toMatchObject({
      exitCode: 0,
      stdout: "ok",
    });
    expect(await shell.executeText({ script: "cat /secret" })).toMatchObject({ exitCode: 126 });
    expect(await shell.executeText({ script: "rm /allowed/input" })).toMatchObject({ exitCode: 126 });
  });

  it("enforces read policy for double-bracket metadata predicates", async () => {
    const fileSystem = new MemoryFileSystem();
    await fileSystem.writeFile("/allowed/input", "ok", { createParents: true });
    await fileSystem.writeFile("/secret", "no");
    const shell = new Shell({
      fileSystem,
      commands: defaultShellCommands,
      policy: { readRoots: ["/allowed"] },
    });
    expect(await shell.executeText({ script: "[[ -f /allowed/input ]]" })).toMatchObject({
      exitCode: 0,
      stderr: "",
    });
    expect(await shell.executeText({ script: "[[ -e /secret ]]" })).toMatchObject({
      exitCode: 126,
      stderr: expect.stringContaining("outside the readable roots"),
    });
    expect(await shell.executeText({ script: "[[ -e /allowed/../secret ]]" })).toMatchObject({
      exitCode: 126,
      stderr: expect.stringContaining("outside the readable roots"),
    });
  });

  it("allows script functions under command policy while checking their bodies", async () => {
    const fileSystem = new MemoryFileSystem();
    const shell = new Shell({
      fileSystem,
      commands: defaultShellCommands,
      policy: { allowedCommands: ["printf"] },
    });
    expect(await shell.executeText({ script: "say() { printf allowed; }; say" }))
      .toMatchObject({ exitCode: 0, stdout: "allowed" });
    expect(await shell.executeText({ script: "remove() { rm /anything; }; remove" }))
      .toMatchObject({ exitCode: 126 });
  });

  it("applies command, path, opaque-content, size, and cancellation boundaries to source", async () => {
    const fileSystem = new MemoryFileSystem();
    await fileSystem.writeFile("/allowed/library.sh", "printf allowed", { createParents: true });
    await fileSystem.writeFile("/secret.sh", "printf secret");

    const scoped = new Shell({
      fileSystem,
      commands: defaultShellCommands,
      policy: {
        readRoots: ["/allowed"],
        writeRoots: ["/allowed"],
        allowedCommands: ["source", "printf"],
      },
    });
    await expect(scoped.executeText({ script: "source /allowed/library.sh" })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "allowed",
    });
    await expect(scoped.executeText({ script: "source /secret.sh" })).resolves.toMatchObject({
      exitCode: 126,
      stdout: "",
    });

    const commandDenied = new Shell({
      fileSystem,
      commands: defaultShellCommands,
      policy: { allowedCommands: ["printf"] },
    });
    await expect(commandDenied.executeText({ script: "source /allowed/library.sh" }))
      .resolves.toMatchObject({ exitCode: 126, stdout: "" });

    const store = new MemoryOpaqueStore();
    const opaqueFileSystem = new MemoryFileSystem({ opaqueStore: store });
    await putOpaque(opaqueFileSystem, store, "/opaque.sh", "printf hidden");
    const opaqueShell = new Shell({ fileSystem: opaqueFileSystem, commands: defaultShellCommands });
    await expect(opaqueShell.executeText({ script: "source /opaque.sh" })).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr: expect.stringContaining("opaque R2 content is not available"),
    });

    const limited = createBashHarness({ limits: { maxScriptBytes: 16 } });
    await limited.fileSystem.writeFile("/large", "printf way-too-large");
    await expect(limited.run("source /large")).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("/large: sourced file exceeds the script byte limit"),
    });

    const bufferLimited = createBashHarness({ limits: { maxBufferedBytes: 1 } });
    await bufferLimited.fileSystem.writeFile("/tiny.sh", "true");
    await expect(bufferLimited.run("source /tiny.sh")).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("/tiny.sh: shell buffered-byte limit exceeded"),
    });

    const cancelled = createBashHarness();
    await cancelled.fileSystem.writeFile("/cancelled.sh", "printf no");
    const abort = new AbortController();
    abort.abort();
    await expect(cancelled.run("source /cancelled.sh", { signal: abort.signal }))
      .resolves.toMatchObject({ exitCode: 1, stdout: "" });
  });

  it("keeps opaque bodies outside shell content commands", async () => {
    const store = new MemoryOpaqueStore();
    const fileSystem = new MemoryFileSystem({ opaqueStore: store });
    await putOpaque(fileSystem, store, "/opaque", "secret");
    const shell = new Shell({ fileSystem, commands: defaultShellCommands });
    const result = await shell.executeText({ script: "stat /opaque; cat /opaque" });
    expect(result.stdout).toContain("opaque file");
    expect(result).toMatchObject({ exitCode: 1 });
    expect(result.stderr).toContain("opaque R2 content is not available to shell commands");
  });

  it("rejects opaque append but atomically replaces opaque content with inline output", async () => {
    const store = new MemoryOpaqueStore();
    const fileSystem = new MemoryFileSystem({ opaqueStore: store });
    const upload = fileSystem.beginOpaqueUpload("/opaque");
    await store.putIfAbsent(upload.objectKey, "secret");
    await fileSystem.commitOpaqueUpload(upload.uploadId);
    const shell = new Shell({ fileSystem, commands: defaultShellCommands });

    const append = await shell.executeText({ script: "printf appended >> /opaque" });
    expect(append).toMatchObject({ exitCode: 1 });
    expect(fileSystem.stat("/opaque")).toMatchObject({ contentClass: "opaque", sizeBytes: 6 });
    expect(store.has(upload.objectKey)).toBe(true);

    const replace = await shell.executeText({ script: "printf inline > /opaque" });
    expect(replace).toMatchObject({ exitCode: 0, stderr: "" });
    expect(fileSystem.stat("/opaque")).toMatchObject({ contentClass: "inline", sizeBytes: 6 });
    expect(await fileSystem.drainGarbage()).toEqual({ deleted: 1, remaining: 0 });
    expect(store.has(upload.objectKey)).toBe(false);
  });

  it("uses a trusted opaque digest without reading the R2 body", async () => {
    const store = new MemoryOpaqueStore({ verifySha256: true });
    const fileSystem = new MemoryFileSystem({ opaqueStore: store });
    await putOpaque(fileSystem, store, "/opaque", "body");
    const shell = new Shell({ fileSystem, commands: defaultShellCommands });
    const result = await shell.executeText({ script: "sha256sum /opaque" });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "230d8358dc8e8890b4c58deeb62912ee2f20357ae92a5cc861b98e68fe31acb5  /opaque\n",
      stderr: "",
    });
  });

  it("drains stdout and stderr concurrently in executeText", async () => {
    const noisy = defineCommand("noisy", async (_context, _argv, fds) => {
      const block = "x".repeat(128 * 1024);
      for (let index = 0; index < 16; index += 1) {
        await Promise.all([writeText(fds[1], block), writeText(fds[2], block)]);
      }
      return 0;
    });
    const { shell } = createBashHarness({ extraCommands: [noisy] });
    const result = await shell.executeText({ script: "noisy" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(2 * 1024 * 1024);
    expect(result.stderr.length).toBe(2 * 1024 * 1024);
  });

  it("keeps incremental UTF-8 text output independent of source chunk boundaries", async () => {
    const { shell } = createBashHarness();
    const source = new TextEncoder().encode("가나다\nalpha\n나비\n");
    for (const chunkBytes of [1, 2, 5, 7]) {
      const chunks = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < source.byteLength; offset += chunkBytes) {
            controller.enqueue(source.slice(offset, offset + chunkBytes));
          }
          controller.close();
        },
      });
      const result = await shell.executeText({ script: "grep 나 | nl", stdin: chunks });
      expect(result).toMatchObject({
        exitCode: 0,
        stdout: "     1\t가나다\n     2\t나비\n",
        stderr: "",
      });
    }
    expect(await shell.executeText({
      script: "grep anything",
      stdin: new Uint8Array([0xe2, 0x82]),
    })).toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr: expect.stringContaining("valid UTF-8"),
    });
  });

  it("does not complete a producer until its consumer relieves backpressure", async () => {
    const produce = defineCommand("produce", async (_context, _argv, fds) => {
      await fds[1].write(new Uint8Array(128 * 1024));
      return 0;
    });
    const { shell } = createBashHarness({ extraCommands: [produce] });
    const execution = shell.executeStream({ script: "produce" });
    let completed = false;
    void execution.completed.then(() => { completed = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(completed).toBe(false);
    const [output, error, status] = await Promise.all([
      readAllBytes(execution.stdout, 256 * 1024),
      readAllBytes(execution.stderr, 1024),
      execution.completed,
    ]);
    expect(output.byteLength).toBe(128 * 1024);
    expect(error.byteLength).toBe(0);
    expect(status.exitCode).toBe(0);
  });

  it("treats a downstream head close as a successful pipeline edge under pipefail", async () => {
    const { fileSystem, shell } = createBashHarness({
      fileSystem: new MemoryFileSystem({ chunkBytes: 1024 }),
    });
    await fileSystem.writeFile("/many", "first\n" + "next\n".repeat(1000));
    const result = await shell.executeText({
      script: "set -o pipefail; cat /many | head -n 1; printf '%s\\n' $?",
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "first\n0\n", stderr: "" });
  });

  it("rolls back an atomic redirection when its byte limit is exceeded", async () => {
    const spam = defineCommand("spam", async (_context, _argv, fds) => {
      const chunk = new Uint8Array(1024 * 1024);
      for (let index = 0; index < 9; index += 1) await fds[1].write(chunk);
      return 0;
    });
    const { fileSystem, shell } = createBashHarness({ extraCommands: [spam] });
    await fileSystem.writeFile("/target", "old");
    const result = await shell.executeText({ script: "spam > /target" });
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/target").stream, 16)))
      .toBe("old");
  });

  it("rolls back an atomic redirection when the caller cancels execution", async () => {
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const waiting = defineCommand("waiting", async (context, _argv, fds) => {
      await writeText(fds[1], "new");
      signalStarted?.();
      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(context.signal.reason);
        if (context.signal.aborted) abort();
        else context.signal.addEventListener("abort", abort, { once: true });
      });
      return 0;
    });
    const { fileSystem, shell } = createBashHarness({ extraCommands: [waiting] });
    await fileSystem.writeFile("/target", "old");
    const execution = shell.executeStream({ script: "waiting > /target" });
    const stdout = readAllBytes(execution.stdout, 16).catch(() => new Uint8Array());
    const stderr = readAllBytes(execution.stderr, 1024).catch(() => new Uint8Array());
    await started;
    execution.cancel();
    expect(await execution.completed).toEqual({ exitCode: 1 });
    await Promise.all([stdout, stderr]);
    expect(new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/target").stream, 16)))
      .toBe("old");
  });

  it("wakes a backpressured producer when the execution deadline expires", async () => {
    const produce = defineCommand("produce", async (_context, _argv, fds) => {
      while (true) await fds[1].write(new Uint8Array(128 * 1024));
    });
    const fileSystem = new MemoryFileSystem();
    const shell = new Shell({
      fileSystem,
      commands: [produce],
      limits: { deadlineMs: 20, maxStdoutBytes: 64 * 1024 * 1024 },
    });
    const execution = shell.executeStream({ script: "produce" });
    await expect(execution.completed).resolves.toEqual({ exitCode: 1 });
  });

  it("wakes a pending stdin read on cancellation", async () => {
    const shell = new Shell({
      fileSystem: new MemoryFileSystem(),
      commands: defaultShellCommands,
      limits: { deadlineMs: 1_000 },
    });
    const execution = shell.executeStream({
      script: "cat",
      stdin: new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) }),
    });
    const stdout = readAllBytes(execution.stdout, 16).catch(() => new Uint8Array());
    const stderr = readAllBytes(execution.stderr, 1024).catch(() => new Uint8Array());
    execution.cancel();
    const result = await Promise.race([
      execution.completed,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("cancel hung")), 100)),
    ]);
    expect(result).toEqual({ exitCode: 1 });
    await Promise.all([stdout, stderr]);
  });

  it("cancels execution when the caller cancels a root output stream", async () => {
    const waitForCancel = defineCommand("wait-for-cancel", async (context, _argv, fds) => {
      await writeText(fds[1], "x");
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(context.signal.reason);
        if (context.signal.aborted) abort();
        else context.signal.addEventListener("abort", abort, { once: true });
      });
      return 0;
    });
    const { shell } = createBashHarness({ extraCommands: [waitForCancel] });
    const execution = shell.executeStream({ script: "wait-for-cancel" });
    const reader = execution.stdout.getReader();
    await reader.read();
    await reader.cancel();
    await execution.stderr.cancel().catch(() => undefined);
    await expect(execution.completed).resolves.toEqual({ exitCode: 1 });
  });

  it("enforces an output idle timeout independently of the execution deadline", async () => {
    const produce = defineCommand("produce", async (_context, _argv, fds) => {
      while (true) await fds[1].write(new Uint8Array(128 * 1024));
    });
    const shell = new Shell({
      fileSystem: new MemoryFileSystem(),
      commands: [produce],
      limits: {
        deadlineMs: 1_000,
        outputIdleTimeoutMs: 20,
        maxStdoutBytes: 64 * 1024 * 1024,
      },
    });
    await expect(shell.executeStream({ script: "produce" }).completed)
      .resolves.toEqual({ exitCode: 1 });
  });

  it("rejects completed for a command invariant failure", async () => {
    const broken = defineCommand("broken", () => {
      throw new Error("command invariant failed");
    });
    const { shell } = createBashHarness({ extraCommands: [broken] });
    const execution = shell.executeStream({ script: "broken" });
    await expect(execution.completed).rejects.toThrow("command invariant failed");
    await expect(readAllBytes(execution.stdout, 1024)).rejects.toThrow("command invariant failed");
    await expect(readAllBytes(execution.stderr, 1024)).rejects.toThrow("command invariant failed");
  });

  it("returns a failure without a valid truncated prefix when root output overflows", async () => {
    const produce = defineCommand("produce", async (_context, _argv, fds) => {
      await fds[1].write(new Uint8Array(1024));
      return 0;
    });
    const shell = new Shell({
      fileSystem: new MemoryFileSystem(),
      commands: [produce],
      limits: { maxStdoutBytes: 512 },
    });
    await expect(shell.executeText({ script: "produce" })).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
    });
  });

  it("settles command-budget overflow and rejects invalid plugin exit statuses", async () => {
    const limited = new Shell({
      fileSystem: new MemoryFileSystem(),
      commands: defaultShellCommands,
      limits: { maxCommands: 1 },
    });
    await expect(Promise.race([
      limited.executeText({ script: "true; true" }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("budget hung")), 100)),
    ])).resolves.toMatchObject({ exitCode: 1 });

    const invalid = defineCommand("invalid", () => Number.NaN);
    const { shell } = createBashHarness({ extraCommands: [invalid] });
    await expect(shell.executeStream({ script: "invalid" }).completed)
      .rejects.toThrow("invalid exit status");
  });

  it("does not expose mutable policy or the wrapped filesystem to commands", async () => {
    const fileSystem = new MemoryFileSystem();
    await fileSystem.writeFile("/secret", "secret");
    const probe = defineCommand("probe-policy", async (context) => {
      try {
        (context.policy as { readRoots?: string[] }).readRoots = ["/"];
      } catch {
        // Frozen policy views reject mutation.
      }
      expect("inner" in context.fileSystem).toBe(false);
      await context.fileSystem.readFile("/secret");
      return 0;
    });
    const shell = new Shell({
      fileSystem,
      commands: [probe],
      policy: { readRoots: ["/allowed"], writeRoots: ["/allowed"] },
    });
    await expect(shell.executeText({ script: "probe-policy" })).resolves.toMatchObject({ exitCode: 126 });
  });

  it("provides comm, join, and atomic unified patch utilities", async () => {
    const { fileSystem, shell } = createBashHarness();
    await fileSystem.writeFile("/left", "a\nb\n");
    await fileSystem.writeFile("/right", "b\nc\n");
    await fileSystem.writeFile("/users", "1 Alice\n2 Bob\n");
    await fileSystem.writeFile("/roles", "1 admin\n3 guest\n");
    await fileSystem.writeFile("/document", "old\n");
    await fileSystem.writeFile(
      "/change.patch",
      "--- a/document\n+++ b/document\n@@ -1 +1 @@\n-old\n+new\n",
    );
    const result = await shell.executeText({
      script: "comm /left /right; join -a 1 /users /roles; patch /document /change.patch; cat /document",
    });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "a\n\t\tb\n\tc\n1 Alice admin\n2 Bob\nnew\n",
      stderr: "",
    });
  });

  it("smoke-tests the remaining default utility families through the shell", async () => {
    const { fileSystem, shell } = createBashHarness();
    const result = await shell.executeText({
      script: [
        "mkdir -p /u/empty",
        "printf 'b\\na\\na\\n' > /u/data",
        "chmod 600 /u/data",
        "stat /u/data",
        "ls /u",
        "du /u",
        "tree /u",
        "basename /u/data",
        "dirname /u/data",
        "realpath /u/../u/data",
        "mktemp /u/tmp.XXXXXX",
        "file /u/data",
        "tail -n 1 /u/data",
        "wc -l /u/data",
        "uniq /u/data",
        "cut -c 1 /u/data",
        "printf abc | tr a-z A-Z",
        "printf 'x\\n' | nl",
        "printf abcdef | fold -w 3",
        "paste /u/data /u/data",
        "tee /u/tee < /u/data",
        "mv /u/tee /u/moved",
        "rm /u/moved",
        "rmdir /u/empty",
        "[ -f /u/data ]",
        "export Z=ok",
        "unset Z",
      ].join(" && "),
    });
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("inline file");
    expect(result.stdout).toContain("ABC");
    expect(result.stdout).toContain("/u/data");
    expect(() => fileSystem.stat("/u/moved")).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("makes diff output consumable by patch", async () => {
    const { fileSystem, shell } = createBashHarness();
    await fileSystem.writeFile("/before", "one\ntwo\n");
    await fileSystem.writeFile("/after", "one\nchanged\n");
    const result = await shell.executeText({
      script: "diff /before /after > /change.patch || :; patch /before /change.patch; cmp /before /after",
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("shares glob, record, and recursive mutation budgets across the execution", async () => {
    const fileSystem = new MemoryFileSystem();
    await fileSystem.writeFile("/tree/a", "a", { createParents: true });
    await fileSystem.writeFile("/tree/b", "b");
    await fileSystem.writeFile("/tree/c", "c");
    const shell = new Shell({
      fileSystem,
      commands: defaultShellCommands,
      policy: { maxMutations: 2 },
      limits: { maxGlobMatches: 2, maxBufferedRecords: 2, maxLineBytes: 4 },
    });
    expect(await shell.executeText({ script: "printf '%s\n' /tree/*" }))
      .toMatchObject({ exitCode: 1, stdout: "" });
    expect(await shell.executeText({ script: "sort", stdin: "a\nb\nc\n" }))
      .toMatchObject({ exitCode: 1, stdout: "" });
    expect(await shell.executeText({ script: "grep x", stdin: "xxxxx" }))
      .toMatchObject({ exitCode: 1, stdout: "" });
    expect(await shell.executeText({ script: "rm -r /tree" }))
      .toMatchObject({ exitCode: 1 });
    expect(fileSystem.stat("/tree/a").kind).toBe("file");
  });

  it("holds materialized input leases until a multi-file command finishes", async () => {
    const fileSystem = new MemoryFileSystem();
    await fileSystem.writeFile("/left-large", "a".repeat(900));
    await fileSystem.writeFile("/right-large", "b".repeat(900));
    const shell = new Shell({
      fileSystem,
      commands: defaultShellCommands,
      limits: { maxBufferedBytes: 2_000 },
    });
    await expect(shell.executeText({ script: "diff /left-large /right-large" }))
      .resolves.toMatchObject({ exitCode: 1, stdout: "" });
  });

  it("charges glob matches cumulatively across words", async () => {
    const fileSystem = new MemoryFileSystem();
    await fileSystem.writeFile("/g/a", "a", { createParents: true });
    await fileSystem.writeFile("/g/b", "b");
    const shell = new Shell({
      fileSystem,
      commands: defaultShellCommands,
      limits: { maxGlobMatches: 1 },
    });
    await expect(shell.executeText({ script: "printf '%s\\n' /g/a* /g/b*" }))
      .resolves.toMatchObject({ exitCode: 1, stdout: "" });
  });

  it("rejects opaque bodies consistently across body-dependent utilities", async () => {
    const store = new MemoryOpaqueStore();
    const fileSystem = new MemoryFileSystem({ opaqueStore: store });
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
    const fileSystem = new MemoryFileSystem();
    const shell = new Shell({
      fileSystem,
      commands: defaultShellCommands,
      policy: { maxMutations: 1 },
    });
    expect(await shell.executeText({ script: "mkdir -p /one/two" }))
      .toMatchObject({ exitCode: 1 });
    expect(() => fileSystem.stat("/one")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
  });

});

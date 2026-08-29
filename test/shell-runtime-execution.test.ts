import { expect, it } from "vitest";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { writeText } from "../src/shell/commands/helpers.js";
import { Shell } from "../src/shell/shell.js";
import { MemoryOpaqueStore } from "../src/testing/opaque-store.js";
import { putOpaque } from "../src/vfs/opaque.js";
import { readAllBytes } from "../src/vfs/streams.js";
import { defineTestApplet } from "./helpers/applet.js";
import { createBashHarness } from "./helpers/bash.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

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
      'for item in a b c; do test "$item" = b && continue; printf \':%s\' "$item"; test "$item" = c && break; done',
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
  const fileSystem = createTestFileSystem();
  const loopLimited = new Shell({
    fileSystem,
    commands: defaultShellCommands,
    limits: { maxLoopIterations: 2 },
  });
  expect(await loopLimited.executeText({ script: "while true; do :; done" })).toMatchObject({
    exitCode: 1,
    stdout: "",
  });

  const recursive = new Shell({
    fileSystem,
    commands: defaultShellCommands,
    limits: { maxFunctionDepth: 2 },
  });
  expect(await recursive.executeText({ script: "recurse() { recurse; }; recurse" })).toMatchObject({
    exitCode: 1,
  });

  const substitution = new Shell({
    fileSystem,
    commands: defaultShellCommands,
    limits: { maxCommandSubstitutionBytes: 4 },
  });
  expect(
    await substitution.executeText({ script: "printf '%s' \"$(printf 12345)\"" }),
  ).toMatchObject({ exitCode: 1, stdout: "" });

  const bufferedSubstitution = new Shell({
    fileSystem,
    commands: defaultShellCommands,
    limits: { maxBufferedBytes: 4 },
  });
  expect(
    await bufferedSubstitution.executeText({ script: "printf '%s' \"$(printf 12345)\"" }),
  ).toMatchObject({ exitCode: 1, stdout: "" });

  const nested = new Shell({
    fileSystem,
    commands: defaultShellCommands,
    limits: { maxNestingDepth: 1 },
  });
  expect(await nested.executeText({ script: "(true)" })).toMatchObject({ exitCode: 1 });
  expect(await nested.executeText({ script: "printf '%s' \"$((- - 1))\"" })).toMatchObject({
    exitCode: 1,
  });
});

it("enforces command and path capabilities below utilities", async () => {
  const fileSystem = createTestFileSystem();
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
  expect(await shell.executeText({ script: "rm /allowed/input" })).toMatchObject({
    exitCode: 126,
  });
});

it("enforces read policy for double-bracket metadata predicates", async () => {
  const fileSystem = createTestFileSystem();
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
  const fileSystem = createTestFileSystem();
  const shell = new Shell({
    fileSystem,
    commands: defaultShellCommands,
    policy: { allowedCommands: ["printf"] },
  });
  expect(await shell.executeText({ script: "say() { printf allowed; }; say" })).toMatchObject({
    exitCode: 0,
    stdout: "allowed",
  });
  expect(await shell.executeText({ script: "remove() { rm /anything; }; remove" })).toMatchObject({
    exitCode: 126,
  });
});

it("applies command, path, opaque-content, size, and cancellation boundaries to source", async () => {
  const fileSystem = createTestFileSystem();
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
  await expect(scoped.executeText({ script: "source /allowed/library.sh" })).resolves.toMatchObject(
    {
      exitCode: 0,
      stdout: "allowed",
    },
  );
  await expect(scoped.executeText({ script: "source /secret.sh" })).resolves.toMatchObject({
    exitCode: 126,
    stdout: "",
  });

  const commandDenied = new Shell({
    fileSystem,
    commands: defaultShellCommands,
    policy: { allowedCommands: ["printf"] },
  });
  await expect(
    commandDenied.executeText({ script: "source /allowed/library.sh" }),
  ).resolves.toMatchObject({ exitCode: 126, stdout: "" });

  const store = new MemoryOpaqueStore();
  const opaqueFileSystem = createTestFileSystem({ opaqueStore: store });
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
  await expect(
    cancelled.run("source /cancelled.sh", { signal: abort.signal }),
  ).resolves.toMatchObject({ exitCode: 1, stdout: "" });
});

it("keeps opaque bodies outside shell content commands", async () => {
  const store = new MemoryOpaqueStore();
  const fileSystem = createTestFileSystem({ opaqueStore: store });
  await putOpaque(fileSystem, store, "/opaque", "secret");
  const shell = new Shell({ fileSystem, commands: defaultShellCommands });
  const result = await shell.executeText({ script: "stat /opaque; cat /opaque" });
  expect(result.stdout).toContain("opaque file");
  expect(result).toMatchObject({ exitCode: 1 });
  expect(result.stderr).toContain("opaque R2 content is not available to shell commands");
});

it("rejects opaque append but atomically replaces opaque content with inline output", async () => {
  const store = new MemoryOpaqueStore();
  const fileSystem = createTestFileSystem({ opaqueStore: store });
  const upload = await fileSystem.beginOpaqueUpload("/opaque");
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
  const fileSystem = createTestFileSystem({ opaqueStore: store });
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
  const noisy = defineTestApplet("noisy", async (_context, _argv, fds) => {
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
  expect(
    await shell.executeText({
      script: "grep anything",
      stdin: new Uint8Array([0xe2, 0x82]),
    }),
  ).toMatchObject({
    exitCode: 1,
    stdout: "",
    stderr: expect.stringContaining("valid UTF-8"),
  });
});

it("does not complete a producer until its consumer relieves backpressure", async () => {
  const produce = defineTestApplet("produce", async (_context, _argv, fds) => {
    await fds[1].write(new Uint8Array(128 * 1024));
    return 0;
  });
  const { shell } = createBashHarness({ extraCommands: [produce] });
  const execution = shell.executeStream({ script: "produce" });
  let completed = false;
  void execution.completed.then(() => {
    completed = true;
  });
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

it("settles both backpressured outputs before resolving an errexit status", async () => {
  const failAfterOutput = defineTestApplet("fail-after-output", async (_context, _argv, fds) => {
    const chunk = new Uint8Array(128 * 1024);
    await Promise.all([fds[1].write(chunk), fds[2].write(chunk)]);
    return 7;
  });
  const { fileSystem, shell } = createBashHarness({ extraCommands: [failAfterOutput] });
  const execution = shell.executeStream({
    script: "set -e; fail-after-output; touch /after",
  });
  let completed = false;
  void execution.completed.then(() => {
    completed = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(completed).toBe(false);
  const [output, error, status] = await Promise.all([
    readAllBytes(execution.stdout, 256 * 1024),
    readAllBytes(execution.stderr, 256 * 1024),
    execution.completed,
  ]);
  expect(output.byteLength).toBe(128 * 1024);
  expect(error.byteLength).toBe(128 * 1024);
  expect(status.exitCode).toBe(7);
  expect(() => fileSystem.stat("/after")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
});

it("treats a downstream head close as a successful pipeline edge under pipefail", async () => {
  const { fileSystem, shell } = createBashHarness({
    fileSystem: createTestFileSystem({ chunkBytes: 1024 }),
  });
  await fileSystem.writeFile("/many", `first\n${"next\n".repeat(1000)}`);
  const result = await shell.executeText({
    script: "set -e; set -o pipefail; cat /many | head -n 1; printf '%s\\n' $?",
  });
  expect(result).toMatchObject({ exitCode: 0, stdout: "first\n0\n", stderr: "" });
});

it("rolls back an atomic redirection when its byte limit is exceeded", async () => {
  const spam = defineTestApplet("spam", async (_context, _argv, fds) => {
    const chunk = new Uint8Array(1024 * 1024);
    for (let index = 0; index < 9; index += 1) await fds[1].write(chunk);
    return 0;
  });
  const { fileSystem, shell } = createBashHarness({ extraCommands: [spam] });
  await fileSystem.writeFile("/target", "old");
  const result = await shell.executeText({
    script: "set -e; spam > /target; touch /after",
  });
  expect(result.exitCode).toBe(1);
  expect(
    new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/target").stream, 16)),
  ).toBe("old");
  expect(() => fileSystem.stat("/after")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
});

it("rolls back an atomic redirection when the caller cancels execution", async () => {
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const waiting = defineTestApplet("waiting", async (context, _argv, fds) => {
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
  const execution = shell.executeStream({
    script: "set -e; waiting > /target; touch /after",
  });
  const stdout = readAllBytes(execution.stdout, 16).catch(() => new Uint8Array());
  const stderr = readAllBytes(execution.stderr, 1024).catch(() => new Uint8Array());
  await started;
  execution.cancel();
  expect(await execution.completed).toEqual({ exitCode: 1 });
  await Promise.all([stdout, stderr]);
  expect(
    new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/target").stream, 16)),
  ).toBe("old");
  expect(() => fileSystem.stat("/after")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
});

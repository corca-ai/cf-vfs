import { expect, it } from "vitest";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { writeText } from "../src/shell/commands/helpers.js";
import { Shell } from "../src/shell/shell.js";
import { readAllBytes } from "../src/vfs/streams.js";
import { defineTestApplet } from "./helpers/applet.js";
import { createBashHarness } from "./helpers/bash.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

it("wakes a backpressured producer when the execution deadline expires", async () => {
  const produce = defineTestApplet("produce", async (_context, _argv, fds) => {
    while (true) await fds[1].write(new Uint8Array(128 * 1024));
  });
  const fileSystem = createTestFileSystem();
  const shell = new Shell({
    fileSystem,
    commands: [...defaultShellCommands, produce],
    limits: { deadlineMs: 20, maxStdoutBytes: 64 * 1024 * 1024 },
  });
  const execution = shell.executeStream({ script: "set -e; produce; touch /after" });
  await expect(execution.completed).resolves.toEqual({ exitCode: 1 });
  expect(() => fileSystem.stat("/after")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
});

it("wakes a pending stdin read on cancellation", async () => {
  const shell = new Shell({
    fileSystem: createTestFileSystem(),
    commands: defaultShellCommands,
    limits: { deadlineMs: 1_000 },
  });
  const reading = Promise.withResolvers<void>();
  const execution = shell.executeStream({
    script: "set -e; cat; touch /after",
    stdin: new ReadableStream<Uint8Array>({
      pull() {
        reading.resolve();
        return new Promise(() => undefined);
      },
    }),
  });
  const stdout = readAllBytes(execution.stdout, 16).catch(() => new Uint8Array());
  const stderr = readAllBytes(execution.stderr, 1024).catch(() => new Uint8Array());
  await reading.promise;
  execution.cancel();
  const result = await execution.completed;
  expect(result).toEqual({ exitCode: 1 });
  await Promise.all([stdout, stderr]);
});

it("cancels execution when the caller cancels a root output stream", async () => {
  const waitForCancel = defineTestApplet("wait-for-cancel", async (context, _argv, fds) => {
    await writeText(fds[1], "x");
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(context.signal.reason);
      if (context.signal.aborted) abort();
      else context.signal.addEventListener("abort", abort, { once: true });
    });
    return 0;
  });
  const { shell } = createBashHarness({ extraCommands: [waitForCancel] });
  const execution = shell.executeStream({ script: "set -e; wait-for-cancel; touch /after" });
  const reader = execution.stdout.getReader();
  await reader.read();
  await reader.cancel();
  await execution.stderr.cancel().catch(() => undefined);
  await expect(execution.completed).resolves.toEqual({ exitCode: 1 });
});

it("enforces an output idle timeout independently of the execution deadline", async () => {
  const produce = defineTestApplet("produce", async (_context, _argv, fds) => {
    while (true) await fds[1].write(new Uint8Array(128 * 1024));
  });
  const fileSystem = createTestFileSystem();
  const shell = new Shell({
    fileSystem,
    commands: [...defaultShellCommands, produce],
    limits: {
      deadlineMs: 1_000,
      outputIdleTimeoutMs: 20,
      maxStdoutBytes: 64 * 1024 * 1024,
    },
  });
  await expect(
    shell.executeStream({ script: "set -e; produce; touch /after" }).completed,
  ).resolves.toEqual({ exitCode: 1 });
  expect(() => fileSystem.stat("/after")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
});

it("rejects completed for a command invariant failure", async () => {
  const broken = defineTestApplet("broken", () => {
    throw new Error("command invariant failed");
  });
  const { shell } = createBashHarness({ extraCommands: [broken] });
  const execution = shell.executeStream({ script: "set -e; broken; touch /after" });
  await expect(execution.completed).rejects.toThrow("command invariant failed");
  await expect(readAllBytes(execution.stdout, 1024)).rejects.toThrow("command invariant failed");
  await expect(readAllBytes(execution.stderr, 1024)).rejects.toThrow("command invariant failed");
});

it("returns a failure without a valid truncated prefix when root output overflows", async () => {
  const produce = defineTestApplet("produce", async (_context, _argv, fds) => {
    await fds[1].write(new Uint8Array(1024));
    return 0;
  });
  const fileSystem = createTestFileSystem();
  const shell = new Shell({
    fileSystem,
    commands: [...defaultShellCommands, produce],
    limits: { maxStdoutBytes: 512 },
  });
  await expect(
    shell.executeText({ script: "set -e; produce; touch /after" }),
  ).resolves.toMatchObject({
    exitCode: 1,
    stdout: "",
  });
  expect(() => fileSystem.stat("/after")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
});

it("settles command-budget overflow as an execution failure", async () => {
  const limited = new Shell({
    fileSystem: createTestFileSystem(),
    commands: defaultShellCommands,
    limits: { maxCommands: 1 },
  });
  await expect(limited.executeText({ script: "true; true" })).resolves.toMatchObject({
    exitCode: 1,
  });
});

it("rejects an invalid plugin exit status as a broken command contract", async () => {
  const invalid = defineTestApplet("invalid", () => Number.NaN);
  const { shell } = createBashHarness({ extraCommands: [invalid] });
  await expect(shell.executeStream({ script: "invalid" }).completed).rejects.toThrow(
    "invalid exit status",
  );
});

it("does not expose mutable policy or the wrapped filesystem to commands", async () => {
  const fileSystem = createTestFileSystem();
  await fileSystem.writeFile("/secret", "secret");
  const probe = defineTestApplet("probe-policy", async (context) => {
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
  await expect(shell.executeText({ script: "probe-policy" })).resolves.toMatchObject({
    exitCode: 126,
  });
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
    script:
      "comm /left /right; join -a 1 /users /roles; patch /document /change.patch; cat /document",
  });
  expect(result).toMatchObject({
    exitCode: 0,
    stdout: "a\n\t\tb\n\tc\n1 Alice admin\n2 Bob\nnew\n",
    stderr: "",
  });
});

it("uses C-locale case folding and word boundaries", async () => {
  const { shell } = createBashHarness();
  const result = await shell.executeText({
    script: [
      "printf 'k\\nK\\nK\\n' | grep -i k",
      "printf 'k\\nK\\nK\\n' | grep -F -i k",
      "printf 'a b c\\td\\n' | wc -w",
    ].join("; "),
  });
  expect(result).toEqual({
    exitCode: 0,
    stdout: "k\nK\nk\nK\n3\n",
    stderr: "",
  });
});

it("normalizes and deduplicates final unterminated text records", async () => {
  const { shell } = createBashHarness();
  const result = await shell.executeText({
    script: [
      "printf 'x\\nx' | uniq",
      "printf 'x\\ny' | uniq",
      "printf 'x\\nx' | sort -u",
      "printf 'x\\ny' | sort -u",
      "printf '1\\n01\\n1' | sort -n -u",
    ].join("; "),
  });
  expect(result).toEqual({
    exitCode: 0,
    stdout: "x\nx\ny\nx\nx\ny\n1\n",
    stderr: "",
  });
});

it("preserves delimiter-free cut records and validates Unicode delimiters", async () => {
  const { shell } = createBashHarness();
  expect(
    await shell.executeText({
      script: [
        "printf 'plain\\na:b\\n' | cut -d : -f 2",
        "printf ':a::b:\\n' | cut -d : -f 1,3,5",
        "printf 'left💥right\\nplain\\n' | cut -d 💥 -f 2",
      ].join("; "),
    }),
  ).toEqual({
    exitCode: 0,
    stdout: "plain\nb\n::\nright\nplain\n",
    stderr: "",
  });

  for (const script of ["cut -d", "cut -d :: -f 1"]) {
    expect(await shell.executeText({ script })).toMatchObject({ exitCode: 2 });
  }
});

it("supports POSIX cut selections and nondelimited suppression", async () => {
  const { shell } = createBashHarness();
  expect(
    await shell.executeText({
      script: [
        "printf 'abcdef\\n' | cut -c '6,2,4-7,1,2'",
        "printf 'abcdef\\n' | cut -c-3",
        "printf 'abcdef\\n' | cut -c3-",
        "printf 'a:b:c:d\\n' | cut -d: -f '3-,1,2-3'",
        "printf 'abcdef\\n' | cut -c '1 3'",
        "printf 'plain\\na:b\\n' | cut -s -d: -f2",
      ].join("; "),
    }),
  ).toEqual({
    exitCode: 0,
    stdout: "abdef\nabc\ncdef\na:b:c:d\nac\nb\n",
    stderr: "",
  });

  for (const script of ["cut -c 0", "cut -c 4-2", "cut -c 2,,3", "cut -s -c1", "cut -d: -c1"]) {
    expect(await shell.executeText({ script })).toMatchObject({ exitCode: 2, stdout: "" });
  }
});

it("numbers only non-empty lines with nl by default", async () => {
  const { shell } = createBashHarness();
  expect(
    await shell.executeText({
      script: "printf '\\n\\n' | nl; printf '\\na\\n\\nb\\n\\n' | nl",
    }),
  ).toEqual({
    exitCode: 0,
    stdout: [
      "       \n",
      "       \n",
      "       \n",
      "     1\ta\n",
      "       \n",
      "     2\tb\n",
      "       \n",
    ].join(""),
    stderr: "",
  });
});

it("uses the last head and tail count mode without mixing option state", async () => {
  const { shell } = createBashHarness();
  expect(
    await shell.executeText({
      script: [
        "printf 'a\\nb\\nc\\n' | head -c 1 -n 2",
        "printf 'a\\nb\\nc\\n' | head -n 2 -c 1",
        "printf 'a\\nb\\nc\\n' | tail -c 1 -n 2",
        "printf 'a\\nb\\nc\\n' | tail -n 2 -c 1",
      ].join("; "),
    }),
  ).toEqual({
    exitCode: 0,
    stdout: "a\nb\nab\nc\n\n",
    stderr: "",
  });
});

it("merges paired, unpaired, and duplicate join keys in sorted order", async () => {
  const { fileSystem, shell } = createBashHarness();
  await fileSystem.writeFile("/left-join", "b Lb1\nb Lb2\nd Ld\nf Lf\n");
  await fileSystem.writeFile("/right-join", "a Ra\nb Rb1\nb Rb2\nc Rc\nf Rf\ng Rg\n");
  expect(
    await shell.executeText({
      script: "join -a 1 -a 2 /left-join /right-join",
    }),
  ).toEqual({
    exitCode: 0,
    stdout: [
      "a Ra\n",
      "b Lb1 Rb1\n",
      "b Lb1 Rb2\n",
      "b Lb2 Rb1\n",
      "b Lb2 Rb2\n",
      "c Rc\n",
      "d Ld\n",
      "f Lf Rf\n",
      "g Rg\n",
    ].join(""),
    stderr: "",
  });
});

it("validates join input order using UTF-8 byte comparison", async () => {
  const { fileSystem, shell } = createBashHarness();
  await fileSystem.writeFile("/reversed-join", "𐀀 left\n left\n");
  await fileSystem.writeFile("/sorted-join", " right\n𐀀 right\n");
  const result = await shell.executeText({ script: "join /reversed-join /sorted-join" });
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("not sorted");
});

it("uses UTF-8 byte order consistently between sort and comm", async () => {
  const { fileSystem, shell } = createBashHarness();
  await fileSystem.writeFile("/unsorted", "𐀀\n\n");
  const result = await shell.executeText({
    script: "sort /unsorted > /left; sort /unsorted > /right; comm /left /right",
  });
  expect(result).toEqual({
    exitCode: 0,
    stdout: "\t\t\n\t\t𐀀\n",
    stderr: "",
  });
});

it("rejects comm inputs that are reversed in UTF-8 byte order", async () => {
  const { fileSystem, shell } = createBashHarness();
  await fileSystem.writeFile("/reversed", "𐀀\n\n");
  await fileSystem.writeFile("/right", "\n𐀀\n");
  const result = await shell.executeText({ script: "comm /reversed /right" });
  expect(result).toMatchObject({ exitCode: 2, stdout: "" });
  expect(result.stderr).toContain("not sorted");
});

it("keeps basename and dirname lexical around dot-dot components", async () => {
  const { shell } = createBashHarness();

  await expect(
    shell.executeText({
      script:
        "basename 'a/..'; dirname 'a/..'; basename '../'; dirname '../'; basename ''; dirname ''",
    }),
  ).resolves.toMatchObject({
    exitCode: 0,
    stdout: "..\na\n..\n.\n\n.\n",
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

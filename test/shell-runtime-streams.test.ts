import { expect, it } from "vitest";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { writeText } from "../src/shell/commands/helpers.js";
import { createBytePipe } from "../src/shell/pipe.js";
import { Shell } from "../src/shell/shell.js";
import { readAllBytes, streamFromChunks } from "../src/vfs/streams.js";
import { defineTestApplet } from "./helpers/applet.js";
import { createBashHarness } from "./helpers/bash.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

it("snapshots bytes once before a pipeline or redirection accepts them", async () => {
  const abort = new AbortController();
  const pipe = createBytePipe({ maximumBytes: 1024, signal: abort.signal, name: "test pipe" });
  const piped = Uint8Array.of(1, 2, 3);
  const write = pipe.sink.write(piped);
  piped.fill(9);
  await write;
  await pipe.sink.close();
  expect([...(await readAllBytes(pipe.readable, 1024))]).toEqual([1, 2, 3]);

  const snapshot = defineTestApplet("snapshot", async (_context, _argv, fds) => {
    const redirected = Uint8Array.of(4, 5, 6);
    const pending = fds[1].write(redirected);
    redirected.fill(9);
    await pending;
    return 0;
  });
  const { fileSystem, shell } = createBashHarness({ extraCommands: [snapshot] });
  await expect(shell.executeText({ script: "snapshot > /output" })).resolves.toMatchObject({
    exitCode: 0,
  });
  expect([...(await readAllBytes(fileSystem.readFile("/output").stream, 1024))]).toEqual([4, 5, 6]);
});

it("keeps the per-edge pipeline limit at or below 8 MiB", () => {
  expect(
    () =>
      new Shell({
        fileSystem: createTestFileSystem(),
        commands: defaultShellCommands,
        limits: { maxPipelineBytes: 8 * 1024 * 1024 + 1 },
      }),
  ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
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

it("bounds printf field widths before formatting output", async () => {
  const { shell } = createBashHarness({ limits: { maxStdoutBytes: 64 } });
  expect(await shell.executeText({ script: "printf '%65s' x" })).toMatchObject({
    exitCode: 1,
    stdout: "",
    stderr: expect.stringContaining("printf field width exceeds the execution limit"),
  });
  expect(await shell.executeText({ script: "printf '%*s' 65 x" })).toMatchObject({
    exitCode: 1,
    stdout: "",
    stderr: expect.stringContaining("printf field width exceeds the execution limit"),
  });
  expect(await shell.executeText({ script: "printf '%#u' 1" })).toMatchObject({
    exitCode: 2,
    stdout: "",
    stderr: expect.stringContaining("printf: unsupported flag #"),
  });
});

it("cancels sed input as soon as an addressed q runs", async () => {
  const encoder = new TextEncoder();
  let pulls = 0;
  let cancelled = false;
  const stdin = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        if (pulls > 1_000) controller.close();
        else controller.enqueue(encoder.encode(`${pulls}\n`));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const { shell } = createBashHarness();
  expect(await shell.executeText({ script: "sed '1q'", stdin })).toEqual({
    exitCode: 0,
    stdout: "1\n",
    stderr: "",
  });
  expect(pulls).toBe(1);
  expect(cancelled).toBe(true);
});

it("keeps ! inside command words and follows Bash positional expansion rules", async () => {
  const bang = defineTestApplet("!echo", async (_context, argv, fds) => {
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
  // `find` reports each match the way the operand was written, as GNU does.
  expect(result.stdout).toBe("src/a.ts\nsrc/b.ts\n");
  expect(
    new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/files.txt").stream, 1024)),
  ).toBe("src/a.ts\nsrc/b.ts\n");
});

it("lets touch -c ignore only missing targets", async () => {
  const { fileSystem, shell } = createBashHarness();
  expect(
    await shell.executeText({
      script: "touch /existing; touch -c /missing /existing; [[ ! -e /missing && -e /existing ]]",
    }),
  ).toMatchObject({ exitCode: 0, stderr: "" });
  expect(() => fileSystem.stat("/missing")).toThrowError(
    expect.objectContaining({ code: "ENOENT" }),
  );

  const restricted = new Shell({
    fileSystem,
    commands: defaultShellCommands,
    policy: { writeRoots: ["/allowed"] },
  });
  expect(await restricted.executeText({ script: "touch -c /forbidden" })).toMatchObject({
    exitCode: 126,
    stderr: expect.stringContaining("writable roots"),
  });
});

it.each([
  ["pwd", "pwd -Z"],
  ["mktemp", "mktemp -d candidate.XXXXXX"],
  ["fold", "fold -x"],
  ["nl", "nl -x"],
  ["fold missing width", "fold -w"],
])("rejects unsupported or incomplete %s options with usage status", async (_name, script) => {
  const { fileSystem, shell } = createBashHarness();
  const result = await shell.executeText({ script });
  expect(result.exitCode).toBe(2);
  expect(result.stderr.length).toBeGreaterThan(0);
  expect((await fileSystem.list("/")).map((entry) => entry.name)).not.toContainEqual(
    expect.stringMatching(/^candidate\./u),
  );
});

it("combines supported flag options consistently across filesystem and text utilities", async () => {
  const { fileSystem, shell } = createBashHarness();
  const result = await shell.executeText({
    script: [
      "mkdir -pm700 /src/sub",
      "printf '10\\n2\\n2\\n' > /src/numbers",
      "cp -Rf /src /copy",
      "ls -ald /copy/sub",
      "printf '10\\n2\\n2\\n' | sort -run",
      "printf 'Alpha\\nbeta\\n' | grep -inF alpha",
      "printf 'a b\\n' | wc -lwc",
      "printf 'a\\nb\\n' > /left",
      "printf 'b\\nc\\n' > /right",
      "comm -12 /left /right",
      "rm -rf /copy",
    ].join("; "),
  });

  expect(result).toEqual({
    exitCode: 0,
    // `ls -d` names the operand as it was written, as GNU does.
    stdout: ["drwx------ 0 0        0 /copy/sub\n", "10\n2\n", "1:Alpha\n", "1 2 4\n", "b\n"].join(
      "",
    ),
    stderr: "",
  });
  expect(() => fileSystem.stat("/copy")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
});

it("accepts attached option arguments and -- terminated dash-prefixed operands", async () => {
  const { shell } = createBashHarness();
  const result = await shell.executeText({
    script: [
      "printf 'a:1\\nb:2\\n' > /left-join",
      "printf 'a:x\\nb:y\\n' > /right-join",
      "head -1 /left-join",
      "tail --bytes=2 /left-join",
      "cut -d: -f2 /left-join",
      "printf abcde | fold -w2",
      "printf '\\n'",
      "join -t: -11 -21 /left-join /right-join",
      "printf xy > ./-data",
      "wc -c -- -data",
    ].join("; "),
  });

  expect(result).toEqual({
    exitCode: 0,
    stdout: ["a:1\n", "2\n", "1\n2\n", "ab\ncd\ne\n", "a:1:x\nb:2:y\n", "2 -data\n"].join(""),
    stderr: "",
  });
});

it("reports the exact unsupported member of a short-option cluster", async () => {
  const { shell } = createBashHarness();
  expect(await shell.executeText({ script: "ls -als" })).toMatchObject({
    exitCode: 2,
    stderr: expect.stringContaining("ls: unsupported option -s"),
  });
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

it("preserves arbitrary bytes in byte-oriented head, tail, and wc modes", async () => {
  const { fileSystem, shell } = createBashHarness();
  await fileSystem.writeFile("/binary", new Uint8Array([0x61, 0xff, 0x0a, 0x00]));

  for (const [script, expected] of [
    ["head -c 2 /binary", [0x61, 0xff]],
    ["tail -c 3 /binary", [0xff, 0x0a, 0x00]],
  ] as const) {
    const execution = shell.executeStream({ script });
    const [stdout, stderr, status] = await Promise.all([
      readAllBytes(execution.stdout, 16),
      readAllBytes(execution.stderr, 128),
      execution.completed,
    ]);
    expect([...stdout], script).toEqual(expected);
    expect(stderr.byteLength, script).toBe(0);
    expect(status.exitCode, script).toBe(0);
  }

  expect(await shell.executeText({ script: "wc -c /binary" })).toMatchObject({
    exitCode: 0,
    stdout: "4 /binary\n",
    stderr: "",
  });
});

it("rejects invalid UTF-8 in line-oriented head and wc modes", async () => {
  const { fileSystem, shell } = createBashHarness();
  await fileSystem.writeFile("/invalid", new Uint8Array([0x61, 0xff, 0x0a]));

  for (const script of [
    "head -n 1 /invalid > /head-output",
    "tail -n 1 /invalid",
    "wc -l /invalid",
    "wc -w /invalid",
    "wc /invalid",
  ]) {
    const result = await shell.executeText({ script });
    expect(result.exitCode, script).toBe(1);
    expect(result.stderr, script).toContain("valid UTF-8");
  }
  expect((await fileSystem.stat("/head-output")).sizeBytes).toBe(0);
});

it("handles split UTF-8 sequences consistently in head, tail, and wc text modes", async () => {
  const { shell } = createBashHarness();
  const source = new TextEncoder().encode("가\n나 다\n");
  const input = (chunkBytes: number): ReadableStream<Uint8Array> =>
    streamFromChunks(
      Array.from({ length: Math.ceil(source.byteLength / chunkBytes) }, (_unused, index) =>
        source.slice(index * chunkBytes, (index + 1) * chunkBytes),
      ),
    );
  const expected = new Map([
    ["head -n 1", "가\n"],
    ["tail -n 1", "나 다\n"],
    ["wc -l", "2\n"],
    ["wc -w", "3\n"],
    ["wc", `2 3 ${source.byteLength}\n`],
  ]);
  for (const chunkBytes of [1, 2, 4]) {
    for (const [script, stdout] of expected) {
      expect(
        await shell.executeText({ script, stdin: input(chunkBytes) }),
        `${script}, ${chunkBytes}`,
      ).toEqual({ exitCode: 0, stdout, stderr: "" });
    }
  }
});

it("validates only the consumed head text regardless of source chunk boundaries", async () => {
  const { shell } = createBashHarness();
  for (const chunks of [
    [new Uint8Array([0x61, 0x0a, 0xff, 0x0a])],
    [new Uint8Array([0x61, 0x0a]), new Uint8Array([0xff, 0x0a])],
  ]) {
    expect(
      await shell.executeText({
        script: "head -n 1",
        stdin: streamFromChunks(chunks),
      }),
    ).toEqual({ exitCode: 0, stdout: "a\n", stderr: "" });
  }
});

it("keeps split invalid bytes opaque in head, tail, and wc byte modes", async () => {
  const { shell } = createBashHarness();
  const chunks = (): ReadableStream<Uint8Array> =>
    streamFromChunks([Uint8Array.of(0x61), Uint8Array.of(0xff), Uint8Array.of(0x0a)]);
  for (const [script, expected] of [
    ["head -c 2", [0x61, 0xff]],
    ["tail -c 2", [0xff, 0x0a]],
  ] as const) {
    const execution = shell.executeStream({ script, stdin: chunks() });
    const [stdout, stderr, status] = await Promise.all([
      readAllBytes(execution.stdout, 16),
      readAllBytes(execution.stderr, 128),
      execution.completed,
    ]);
    expect([...stdout], script).toEqual(expected);
    expect(stderr.byteLength, script).toBe(0);
    expect(status.exitCode, script).toBe(0);
  }
  expect(await shell.executeText({ script: "wc -c", stdin: chunks() })).toEqual({
    exitCode: 0,
    stdout: "3\n",
    stderr: "",
  });
});

it("commits normal-close redirections even for a non-zero command", async () => {
  const { fileSystem, shell } = createBashHarness();
  await fileSystem.writeFile("/file", "old");
  const result = await shell.executeText({ script: "set -e; false > /file; touch /after" });
  expect(result.exitCode).toBe(1);
  expect((await fileSystem.stat("/file")).sizeBytes).toBe(0);
  expect(() => fileSystem.stat("/after")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
});

it("honors left-to-right fd duplication", async () => {
  const emit = defineTestApplet("emit", async (_context, _argv, fds) => {
    await Promise.all([writeText(fds[1], "out\n"), writeText(fds[2], "err\n")]);
    return 0;
  });
  const { fileSystem, shell } = createBashHarness({ extraCommands: [emit] });
  const result = await shell.executeText({
    script: "emit > /both 2>&1; emit 2>&1 > /stdout",
  });
  expect(result.stdout).toBe("err\n");
  expect(result.stderr).toBe("");
  expect(
    new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/both").stream, 32)),
  ).toBe("out\nerr\n");
  expect(
    new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/stdout").stream, 32)),
  ).toBe("out\n");
});

it("duplicates standard output onto standard error with >&2", async () => {
  const harness = createBashHarness();
  // The mirror of `2>&1`, over the two descriptors that exist. `1>&2` is the
  // same redirection with the descriptor `>` already implies.
  const result = await harness.run("echo out; echo err >&2; echo also 1>&2");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("out\n");
  expect(result.stderr).toBe("err\nalso\n");

  // Left to right, like every other redirection here: the duplicate takes
  // where the descriptor points at the moment it is applied.
  await harness.fileSystem.mkdir("/d", true);
  const ordered = await harness.run("sh -c 'echo x >&2' 2> /d/captured; cat /d/captured");
  expect(ordered.exitCode).toBe(0);
  expect(ordered.stdout).toBe("x\n");

  // Releasing the duplicate must not tear down the descriptor it copied.
  const survives = await harness.run("echo a; echo b >&2; echo c");
  expect(survives.stdout).toBe("a\nc\n");
  expect(survives.stderr).toBe("b\n");
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
  const fileSystem = createTestFileSystem();
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
  expect(
    new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/output/new").stream, 16)),
  ).toBe("direct");
  expect(
    new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/output/copy").stream, 16)),
  ).toBe("body");
});

it("aborts an opened atomic target if a later redirection cannot be applied", async () => {
  const { fileSystem, shell } = createBashHarness();
  await fileSystem.writeFile("/target", "old");
  await fileSystem.mkdir("/directory");
  const result = await shell.executeText({ script: "printf new > /target > /directory" });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("is a directory");
  expect(
    new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/target").stream, 16)),
  ).toBe("old");
});

it("names the operand, not what it resolved to, when a body cannot be read", async () => {
  const { fileSystem, shell } = createBashHarness();
  await fileSystem.mkdir("/subdirectory");
  await fileSystem.symlink("/link", "/subdirectory");
  // `cat link` is a complaint about `link`. Reading resolves before it
  // refuses, so the diagnostic has to be restated against what was named.
  const result = await shell.executeText({ script: "cat /link" });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("/link: is a directory");
  expect(result.stderr).not.toContain("/subdirectory");
});

it("reports an atomic redirection close failure instead of discarding it", async () => {
  const mutateTarget = defineTestApplet("mutate-target", async (context, _argv, fds) => {
    await writeText(fds[1], "new");
    await context.fileSystem.touch("/target");
    return 0;
  });
  const { fileSystem, shell } = createBashHarness({ extraCommands: [mutateTarget] });
  await fileSystem.writeFile("/target", "old");
  const result = await shell.executeText({
    script: "set -e; mutate-target > /target; touch /after",
  });
  expect(result).toMatchObject({ exitCode: 1 });
  expect(result.stderr).toContain("mutation token");
  expect(
    new TextDecoder().decode(await readAllBytes(fileSystem.readFile("/target").stream, 16)),
  ).toBe("old");
  expect(() => fileSystem.stat("/after")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
});

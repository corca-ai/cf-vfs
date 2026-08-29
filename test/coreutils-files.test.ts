import { afterEach, describe, expect, it, vi } from "vitest";
import { bashCases, createBashHarness } from "./helpers/bash.js";

const TREE = {
  "/t/a.txt": "alpha\nbeta\n",
  "/t/sub/b.txt": "gamma\nalpha\n",
  "/t/c.log": "nothing\n",
};

afterEach(() => vi.useRealTimers());

const INPUT = "printf 'one\\ntwo\\nthree\\nfour\\n' | ";
bashCases([
  { name: "prints a numbered record with -n", script: `${INPUT}sed -n '2p'`, stdout: "two\n" },
  {
    name: "deletes a numbered record",
    script: `${INPUT}sed '2d'`,
    stdout: "one\nthree\nfour\n",
  },
  { name: "selects a range", script: `${INPUT}sed -n '2,3p'`, stdout: "two\nthree\n" },
  {
    name: "selects by regular expression",
    script: `${INPUT}sed -n '/^t/p'`,
    stdout: "two\nthree\n",
  },
  { name: "selects the last record", script: `${INPUT}sed -n '$p'`, stdout: "four\n" },
  { name: "negates a selection", script: `${INPUT}sed -n '2!p'`, stdout: "one\nthree\nfour\n" },
  {
    name: "applies repeated expressions in order",
    script: `${INPUT}sed -e 's/one/1/' -e 's/two/2/'`,
    stdout: "1\n2\nthree\nfour\n",
  },
  {
    name: "selects POSIX extended regular expressions with -E",
    script: `${INPUT}sed -E 's/(one|two)/X/'`,
    stdout: "X\nX\nthree\nfour\n",
  },
  {
    name: "quits after the addressed record",
    script: `${INPUT}sed 's/two/TWO/;2q;s/three/THREE/'`,
    stdout: "one\nTWO\n",
  },
  {
    name: "honors quiet and explicit printing before q",
    script: `${INPUT}sed -n '2p;2q'`,
    stdout: "two\n",
  },
  {
    name: "q terminates an unterminated record with a newline",
    script: "printf x | sed 'q'",
    stdout: "x\n",
  },
  {
    name: "refuses a q command with two addresses",
    script: `${INPUT}sed '1,2q'`,
    exitCode: 2,
    stderrIncludes: "sed: q accepts at most one address",
  },
  {
    name: "expands a capture group and the whole match",
    script: String.raw`printf 'two\n' | sed 's/\(t\)wo/[\1]/'`,
    stdout: "[t]\n",
  },
  {
    name: "replaces only the requested occurrence",
    script: "printf 'oxoxo\\n' | sed 's/o/0/2'",
    stdout: "ox0xo\n",
  },
  {
    name: "replaces from the requested occurrence with g",
    script: "printf 'oxoxo\\n' | sed 's/o/0/2g'",
    stdout: "ox0x0\n",
  },
  {
    name: "refuses a command outside the subset",
    script: "printf 'x\\n' | sed 'y/a/b/'",
    exitCode: 2,
    stderrIncludes: "sed: unsupported command y",
  },
  {
    name: "refuses an unterminated expression",
    script: "printf 'x\\n' | sed 's/a/b'",
    exitCode: 2,
    stderrIncludes: "sed: unterminated expression",
  },
]);

it("publishes an in-place edit as one guarded write", async () => {
  const harness = createBashHarness();
  await harness.fileSystem.writeFile("/edit.txt", "alpha\nbeta\n");
  harness.fileSystem.setMetadata("/edit.txt", { mode: 0o100640 });
  const before = harness.fileSystem.stat("/edit.txt");
  const result = await harness.run("sed -i 's/alpha/ALPHA/' /edit.txt");
  expect(result.exitCode).toBe(0);
  expect(await harness.readText("/edit.txt")).toBe("ALPHA\nbeta\n");
  const after = harness.fileSystem.stat("/edit.txt");
  // The edit republishes the file, so the revision moves and the mode stays.
  expect(after.revision).not.toBe(before.revision);
  expect(after.mode).toBe(0o100640);
});

it("refuses an in-place edit with no file operand", async () => {
  const harness = createBashHarness();
  const result = await harness.run("printf 'x\\n' | sed -i 's/x/y/'");
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("sed: -i requires a file operand");
});

it("stops an in-place edit at q without opening later operands", async () => {
  const harness = createBashHarness();
  await harness.fileSystem.writeFile("/first.txt", "one\ntwo\nthree\n");
  await harness.fileSystem.writeFile("/second.txt", "untouched\n");
  const result = await harness.run("sed -i '2q' /first.txt /second.txt");
  expect(result.exitCode).toBe(0);
  expect(await harness.readText("/first.txt")).toBe("one\ntwo\n");
  expect(await harness.readText("/second.txt")).toBe("untouched\n");
});

it("leaves the file untouched when a concurrent write wins", async () => {
  const harness = createBashHarness();
  await harness.fileSystem.writeFile("/race.txt", "alpha\n");
  // A competing writer lands in the window between the token `sed -i` takes
  // and the publication it guards, which is the whole point of the token.
  const writeFile = harness.fileSystem.writeFile.bind(harness.fileSystem);
  let raced = false;
  harness.fileSystem.writeFile = async (path, data, options) => {
    if (!raced && path === "/race.txt" && options?.ifMutationToken !== undefined) {
      raced = true;
      await writeFile(path, "changed\n");
    }
    return writeFile(path, data, options);
  };
  const result = await harness.run("sed -i 's/alpha/beta/' /race.txt");
  expect(raced).toBe(true);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("sed: /race.txt:");
  // The edit is refused whole rather than overwriting the winner.
  expect(await harness.readText("/race.txt")).toBe("changed\n");
});

it("edits the remaining operands after one fails", async () => {
  const harness = createBashHarness();
  await harness.fileSystem.writeFile("/k1.txt", "x\n");
  await harness.fileSystem.writeFile("/k2.txt", "x\n");
  const result = await harness.run("sed -i 's/x/X/' /k1.txt /missing.txt /k2.txt");
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("sed: /missing.txt:");
  expect(await harness.readText("/k1.txt")).toBe("X\n");
  expect(await harness.readText("/k2.txt")).toBe("X\n");
});

describe("find actions", () => {
  bashCases([
    {
      name: "separates matches with NUL under -print0",
      files: TREE,
      script: "find /t -name 'a.txt' -print0 | wc -c",
      stdout: "9\n",
    },
    {
      name: "runs a command once per match",
      files: TREE,
      script: "find /t -name '*.txt' -exec cat {} ';' | sort",
      stdout: "alpha\nalpha\nbeta\ngamma\n",
    },
    {
      name: "batches matches into one invocation",
      files: TREE,
      script: "find /t -name '*.txt' -exec cat {} + | sort",
      stdout: "alpha\nalpha\nbeta\ngamma\n",
    },
    {
      name: "does not fail when a ; invocation does, and does when a + one does",
      files: TREE,
      // POSIX: with `;` the status of each command is `find`'s business and not
      // its result. Only the `+` form propagates a failure.
      script:
        "find /t -name '*.txt' -exec false {} ';'; printf '%s' \"$?\"; " +
        "find /t -name '*.txt' -exec false {} +; printf '%s' \"$?\"",
      stdout: "01",
    },
    {
      name: "substitutes {} everywhere in a word, not only on its own",
      files: TREE,
      script: "find /t -name 'a.txt' -exec printf '[%s]' 'pre{}post' ';'",
      stdout: "[pre/t/a.txtpost]",
    },
    {
      name: "requires a terminator",
      files: TREE,
      script: "find /t -exec cat {}",
      exitCode: 2,
      stderrIncludes: "find: -exec requires ; or +",
    },
    {
      name: "requires {} last when batching",
      files: TREE,
      script: "find /t -exec cat {} extra +",
      exitCode: 2,
      stderrIncludes: "find: -exec ... + requires {} as the last argument",
    },
    {
      name: "refuses -exec beside a print action",
      files: TREE,
      script: "find /t -print -exec cat {} ';'",
      exitCode: 2,
      stderrIncludes: "find: specify either -exec or a print action",
    },
  ]);

  it("runs -exec through the command policy", async () => {
    const harness = createBashHarness({ policy: { allowedCommands: ["find", "printf"] } });
    await harness.fileSystem.writeFile("/t/a.txt", "body", { createParents: true });
    const result = await harness.run("find /t -name '*.txt' -exec cat {} ';'");
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("command is not allowed: cat");
  });

  it("measures maxdepth from a root reached through an intermediate link", async () => {
    const harness = createBashHarness();
    harness.fileSystem.mkdir("/target/sub/deep", true);
    harness.fileSystem.symlink("/link", "/target");

    const result = await harness.run("find /link/sub -maxdepth 0");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("/link/sub\n");
  });
});

describe("listing and metadata", () => {
  it("refuses a symbolic link to a directory without removing the link", async () => {
    const harness = createBashHarness();
    harness.fileSystem.mkdir("/target");
    harness.fileSystem.symlink("/link", "/target");

    const result = await harness.run("rmdir /link");

    expect(result.exitCode).not.toBe(0);
    expect(harness.fileSystem.lstat("/link").kind).toBe("symlink");
    expect(harness.fileSystem.stat("/target").kind).toBe("directory");
  });

  bashCases([
    {
      name: "lists one entry per line",
      files: TREE,
      script: "ls -1 /t",
      stdout: "a.txt\nc.log\nsub\n",
    },
    {
      name: "walks a subtree with -R",
      files: TREE,
      script: "ls -R /t",
      stdout: "/t:\na.txt\nc.log\nsub\n\n/t/sub:\nb.txt\n",
    },
    {
      name: "names the operand as written under -d",
      files: TREE,
      script: "ls -d /t/sub",
      stdout: "/t/sub\n",
    },
    {
      name: "prints selected metadata fields",
      files: { "/f": "body\n" },
      script: "chmod 644 /f; stat -c '%s %a %F' /f",
      stdout: "5 644 regular file\n",
    },
    {
      name: "prints numeric ownership",
      files: { "/f": "body\n" },
      script: "stat -c '%u:%g' /f",
      stdout: "0:0\n",
    },
    {
      // The identity is what a caller keys durable state to, so the shell can
      // read it and a rename does not change what it reads.
      name: "reports an identity that survives a rename",
      files: { "/f": "body\n" },
      script:
        "before=$(stat -c '%i' /f); mv /f /g; [ \"$before\" = \"$(stat -c '%i' /g)\" ] && echo same",
      stdout: "same\n",
    },
    {
      name: "gives a copy an identity of its own",
      files: { "/f": "body\n" },
      script: "cp /f /g; [ \"$(stat -c '%i' /f)\" != \"$(stat -c '%i' /g)\" ] && echo distinct",
      stdout: "distinct\n",
    },
    {
      name: "preserves mode bits with cp -p",
      files: { "/src": "body\n" },
      script: "chmod 751 /src; cp -p /src /dst; stat -c '%a' /dst",
      stdout: "751\n",
    },
  ]);
});

describe("small deterministic utilities", () => {
  bashCases([
    { name: "evaluates integer arithmetic", script: "expr 2 + 3", stdout: "5\n" },
    { name: "truncates integer division", script: "expr 7 / 2", stdout: "3\n" },
    {
      name: "reports a false comparison with status 1",
      script: "expr 1 = 2; printf '%s' \"$?\"",
      stdout: "0\n1",
    },
    { name: "compares strings by byte order", script: "expr abc '<' abd", stdout: "1\n" },
    { name: "measures a string", script: "expr length hello", stdout: "5\n" },
    {
      name: "refuses division by zero",
      script: "expr 1 / 0",
      exitCode: 2,
      stderrIncludes: "expr: division by zero",
    },
    {
      name: "refuses an operator outside the profile",
      script: "expr 2 '^' 3",
      exitCode: 2,
      stderrIncludes: "expr: unsupported operator",
    },
    { name: "returns immediately from a zero sleep", script: "sleep 0; printf ok", stdout: "ok" },
    {
      name: "refuses a fractional duration",
      script: "sleep 0.5",
      exitCode: 2,
      stderrIncludes: "sleep: duration must be a whole number of seconds",
    },
  ]);

  it("prints the injected clock rather than a host clock", async () => {
    const harness = createBashHarness({ now: () => 1_700_000_000_000 });
    expect((await harness.run("date +%F")).stdout).toBe("2023-11-14\n");
    expect((await harness.run("date +%s")).stdout).toBe("1700000000\n");
    expect((await harness.run("date")).stdout).toBe("2023-11-14 22:13:20 UTC\n");
  });

  it("refuses a sleep that could not finish inside the deadline", async () => {
    const harness = createBashHarness({ limits: { deadlineMs: 500 } });
    const result = await harness.run("sleep 5");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("sleep: duration exceeds the remaining execution deadline");
  });

  it("wakes a sleep when the execution is cancelled", async () => {
    vi.useFakeTimers();
    const harness = createBashHarness();
    const controller = new AbortController();
    const running = harness.run("sleep 20; printf finished", { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    const result = await running;
    expect(result.stdout).toBe("");
    // A cancelled execution reports failure rather than succeeding silently,
    // and the statement after the sleep never runs.
    expect(result.exitCode).not.toBe(0);
  });
});

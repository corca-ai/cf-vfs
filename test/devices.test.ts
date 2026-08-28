import { describe, expect, it } from "vitest";
import { DEFAULT_SHELL_LIMITS, ExecutionBudget } from "../src/shell/budget.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { ReservedPathFileSystem } from "../src/shell/devices.js";
import { ScopedFileSystem } from "../src/shell/policy.js";
import { Shell } from "../src/shell/shell.js";
import { hasEntryIdentity, NO_ENTRY_IDENTITY } from "../src/vfs/types.js";
import { bashCases, createBashHarness } from "./helpers/bash.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

describe("reserved paths carry no entry identity", () => {
  it("reports the sentinel for every path answered above the namespace", () => {
    const inner = createTestFileSystem();
    const budget = new ExecutionBudget(DEFAULT_SHELL_LIMITS, () => 0);
    const fileSystem = new ReservedPathFileSystem(new ScopedFileSystem(inner, {}, budget), {
      applets: { directories: ["/bin", "/usr/bin"], names: ["cat"] },
    });

    for (const path of ["/dev/null", "/dev/stdin", "/dev/stdout", "/dev", "/bin", "/usr/bin"]) {
      const stat = fileSystem.stat(path);
      expect(hasEntryIdentity(stat), path).toBe(false);
      expect(stat.ino, path).toBe(NO_ENTRY_IDENTITY);
    }

    // Which is the hazard the sentinel exists to make visible: two device
    // paths are one key to anything that skips the check.
    expect(fileSystem.stat("/dev/null").ino).toBe(fileSystem.stat("/dev/stdout").ino);
  });

  it("reports a real identity for an ordinary entry", async () => {
    const fileSystem = createTestFileSystem();
    await fileSystem.writeFile("/file", "body");
    const stat = fileSystem.stat("/file");
    expect(hasEntryIdentity(stat)).toBe(true);
    expect(stat.ino).toBeGreaterThan(NO_ENTRY_IDENTITY);
  });
});

describe("virtual devices", () => {
  bashCases([
    {
      name: "discards a redirection to /dev/null",
      script: "echo hidden > /dev/null; echo shown",
      stdout: "shown\n",
    },
    {
      name: "sends both descriptors to /dev/null with the usual idiom",
      script: "sh -c 'echo out; echo err > /dev/stderr' > /dev/null 2>&1; echo done",
      stdout: "done\n",
    },
    {
      name: "keeps standard output when only standard error is discarded",
      script: "sh -c 'echo out; echo err > /dev/stderr' 2> /dev/null",
      stdout: "out\n",
    },
    { name: "appends to /dev/null", script: "echo x >> /dev/null; echo ok", stdout: "ok\n" },
    { name: "reads nothing from /dev/null", script: "wc -c < /dev/null", stdout: "0\n" },
    { name: "reads /dev/null as an operand", script: "cat /dev/null; echo ok", stdout: "ok\n" },
    {
      name: "digests /dev/null as an empty byte source",
      script: "sha256sum /dev/null",
      stdout: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  /dev/null\n",
    },
    {
      name: "writes to /dev/null named as an operand",
      script: "echo hi | tee /dev/null | wc -c",
      stdout: "3\n",
    },
    {
      name: "aliases the execution's input at /dev/stdin",
      script: "printf 'in\\n' | cat < /dev/stdin",
      stdout: "in\n",
    },
    {
      name: "aliases the descriptors at /dev/stdout and /dev/stderr",
      script: "echo to-out > /dev/stdout; echo to-err > /dev/stderr",
      stdout: "to-out\n",
      stderrIncludes: "to-err",
    },
    {
      name: "accepts the /dev/fd spellings as the same aliases",
      script: "echo one > /dev/fd/1; echo two > /dev/fd/2; printf 'x\\n' | cat < /dev/fd/0",
      stdout: "one\nx\n",
      stderrIncludes: "two",
    },
    {
      name: "reports a device as a character device",
      script:
        "[ -e /dev/null ] && printf 'e'; [ -f /dev/null ] || printf ' not-f'; " +
        "[ -r /dev/null ] && printf ' r'; [ -w /dev/null ] && printf ' w'; " +
        "[ -d /dev/null ] || printf ' not-d'; [ -c /dev/null ] && printf ' c'; " +
        "printf '\\n'; stat -c '%F %s' /dev/null; stat /dev/null | sed -n '3p'; " +
        "file /dev/null; ls -d /dev/null; ls -l /dev/null",
      stdout:
        "e not-f r w not-d c\ncharacter special file 0\n  Type: character special file\n" +
        "/dev/null: character special file\n" +
        "/dev/null\ncrw-rw-rw- 0 0        0 /dev/null\n",
    },
    {
      name: "refuses a device this profile does not have",
      script: "cat /dev/zero",
      exitCode: 1,
      stderrIncludes: "no such file or directory",
    },
    {
      name: "refuses to read a write-only descriptor path",
      script: "cat /dev/stdout",
      exitCode: 2,
      stderrIncludes: "device is not readable",
    },
    {
      name: "discards through a pipeline without disturbing the rest of it",
      script: "printf 'a\\nb\\nc\\n' | tee /dev/null | grep b",
      stdout: "b\n",
    },
    {
      // Bash agrees: `/dev/stdout` names where the descriptor points when it is
      // opened, which by then is already `/dev/null`.
      name: "reads a descriptor alias against the redirection already applied",
      script: "echo body > /dev/null > /dev/stdout; echo after",
      stdout: "after\n",
    },
  ]);

  it("performs no storage work for a device", async () => {
    const statements: string[] = [];
    const fileSystem = createTestFileSystem({ onStatement: (query) => statements.push(query) });
    const shell = new Shell({ fileSystem, commands: defaultShellCommands });
    // Prove the meter observes this filesystem before asserting a zero.
    await fileSystem.writeFile("/probe.txt", "x\n");
    expect((await shell.executeText({ script: "cat /probe.txt" })).exitCode).toBe(0);
    expect(statements.length).toBeGreaterThan(0);

    statements.length = 0;
    const result = await shell.executeText({
      script: "echo hi > /dev/null; cat /dev/null; stat -c '%F' /dev/null; [ -e /dev/null ]",
    });
    expect(result.exitCode).toBe(0);
    // A device is a name the shell knows, not a row anything could hold.
    expect(statements).toEqual([]);
  });

  it("costs the same I/O budget as writing the bytes to a file", async () => {
    const run = async (limit: number, target: string): Promise<number> => {
      const harness = createBashHarness({ limits: { maxTotalIoBytes: limit } });
      await harness.fileSystem.writeFile("/big.txt", "x".repeat(100_000));
      return (await harness.run(`cat /big.txt > ${target}`)).exitCode;
    };
    // Pinned at the boundary, not far outside it: charging the discard as well
    // as the read would make `> /dev/null` fail here while `> /out.txt` passed,
    // so a script that silences a command would exhaust its budget sooner.
    expect(await run(100_000, "/out.txt")).toBe(0);
    expect(await run(100_000, "/dev/null")).toBe(0);
    expect(await run(50_000, "/out.txt")).not.toBe(0);
    expect(await run(50_000, "/dev/null")).not.toBe(0);
  });

  it("keeps a device alias from closing the descriptor it duplicates", async () => {
    const harness = createBashHarness();
    // The alias is taken while the original is still open and released
    // independently, so the following command still has somewhere to write.
    const result = await harness.run(["echo first > /dev/stdout", "echo second"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("first\nsecond\n");
  });

  it("survives a consumer that stops reading early", async () => {
    const harness = createBashHarness();
    await harness.fileSystem.writeFile("/lines.txt", `${"line\n".repeat(5000)}`);
    const result = await harness.run("cat /lines.txt | tee /dev/null | head -n 1");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("line\n");
  });

  it("wakes a device write when the execution is cancelled", async () => {
    const harness = createBashHarness();
    const controller = new AbortController();
    const started = Date.now();
    // Cancelled while bytes are actually moving into the device, which a sleep
    // in front of one would never exercise. The producer is a loop so it
    // cannot finish before the abort lands.
    const running = harness.run(
      "i=0; while [ $i -lt 200000 ]; do echo x; i=$((i+1)); done > /dev/null; echo finished",
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);
    const result = await running;
    expect(result.stdout).toBe("");
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("exempts a device from the roots without letting it reach the namespace", async () => {
    const scoped = createBashHarness({ policy: { readRoots: ["/w"], writeRoots: ["/w"] } });
    await scoped.fileSystem.mkdir("/w", true);
    await scoped.fileSystem.writeFile("/secret.txt", "secret\n");

    // A device names nothing the roots protect, so requiring `/dev` in every
    // scoped session's roots would break `> /dev/null` and prevent nothing.
    expect((await scoped.run("echo hi > /dev/null; echo ok")).stdout).toBe("ok\n");
    expect((await scoped.run("cat /dev/null; echo ok")).stdout).toBe("ok\n");
    expect((await scoped.run("printf 'x\\n' | cat < /dev/stdin")).stdout).toBe("x\n");
    expect((await scoped.run("echo shown > /dev/stdout")).stdout).toBe("shown\n");

    // The roots still govern everything they name. Nothing reachable through a
    // device leads back into the namespace.
    const denied = await scoped.run("cat /secret.txt");
    expect(denied.exitCode).not.toBe(0);
    expect(denied.stdout).toBe("");
    for (const outward of ["/dev/../secret.txt", "/dev/fd/../../secret.txt"]) {
      const result = await scoped.run(`cat ${outward}`);
      expect(result.exitCode, outward).not.toBe(0);
      expect(result.stdout, outward).toBe("");
    }
  });

  it("reserves the whole device namespace against change", async () => {
    const harness = createBashHarness();
    // Without this the two views could disagree: a real `/dev/null` would be
    // read as the device but removed, moved, and listed as an entry, and a
    // write to it would be silently discarded.
    for (const script of [
      "mkdir /dev",
      "mkdir -p /dev/null",
      "rm /dev/null",
      "touch /dev/null",
      "mv /dev/null /elsewhere",
      "chmod 600 /dev/null",
      "ln -s /tmp /dev/link",
    ]) {
      const result = await harness.run(script);
      expect(result.exitCode, script).not.toBe(0);
      expect(result.stderr, script).toContain("is reserved and cannot be changed");
    }
    // And the directory reads as one, listing exactly what it holds.
    expect((await harness.run("ls /dev")).stdout).toBe("fd\nnull\nstderr\nstdin\nstdout\n");
    expect((await harness.run("find /dev -type f | sort")).stdout).toBe(
      "/dev/fd/0\n/dev/fd/1\n/dev/fd/2\n/dev/null\n/dev/stderr\n/dev/stdin\n/dev/stdout\n",
    );
  });

  it("follows a link to a device", async () => {
    const harness = createBashHarness();
    const result = await harness.run([
      "ln -s /dev/null quiet",
      "echo discarded > quiet",
      "[ -e quiet ] && echo e",
      "[ -c quiet ] && echo c",
      "[ -L quiet ] && echo L",
      "cat quiet; echo empty",
      "stat -L -c '%F' quiet",
      "readlink quiet",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("e\nc\nL\nempty\ncharacter special file\n/dev/null\n");
  });

  it("keeps a failed redirection from destroying the descriptor an alias duplicates", async () => {
    const harness = createBashHarness();
    // The alias must be able to release its own reference without tearing down
    // the stream it duplicates — otherwise a later redirection that fails
    // discards everything the execution had already written.
    const result = await harness.run("echo a; echo b > /dev/stdout > /nope/x; echo c");
    expect(result.stdout).toBe("a\nc\n");
    expect(result.stderr).toContain("no such file or directory");

    const stderrCase = await harness.run("echo a; echo b 2> /dev/stderr 2> /nope/x; echo c");
    expect(stderrCase.stdout).toBe("a\nc\n");
    expect(stderrCase.stderr).toContain("no such file or directory");
  });

  it("shows /dev where a directory of its own would be shown", async () => {
    const harness = createBashHarness();
    await harness.fileSystem.mkdir("/home", true);
    await harness.fileSystem.writeFile("/home/a.txt", "x\n");

    // A directory you can enter, stat, and read must also be one you can see.
    // Answering for `/dev` everywhere except its parent's listing is the same
    // disagreement the reservation exists to prevent.
    expect((await harness.run("ls /")).stdout).toBe("bin\ndev\nhome\nusr\n");
    // `find / -maxdepth 1` is the same question as `ls /`, so it answers the
    // same. What is inside is not reported: those are descriptor paths a
    // recursive reader cannot open.
    expect((await harness.run("find / -maxdepth 1 | sort")).stdout).toBe(
      "/\n/bin\n/dev\n/home\n/usr\n",
    );
    expect((await harness.run("find / -type f | sort")).stdout).toBe("/home/a.txt\n");
    expect((await harness.run("find / -name dev")).stdout).toBe("/dev\n");
    // Naming it directly still lists what it holds.
    expect((await harness.run("find /dev -type f | sort")).stdout).toBe(
      "/dev/fd/0\n/dev/fd/1\n/dev/fd/2\n/dev/null\n/dev/stderr\n/dev/stdin\n/dev/stdout\n",
    );
  });

  it("returns every root entry exactly once when the listing is paged", async () => {
    const fileSystem = createTestFileSystem();
    for (const name of ["alpha", "beta", "zeta"]) await fileSystem.mkdir(`/${name}`, true);
    // No applet directories here: this is about placing a synthetic entry in a
    // paged listing, and `/dev` alone shows that without 57 more names.
    const view = new ReservedPathFileSystem(
      new ScopedFileSystem(fileSystem, {}, new ExecutionBudget(DEFAULT_SHELL_LIMITS, Date.now)),
    );

    // Walked one entry at a time, so the synthetic entry has to land in exactly
    // one page rather than in every page or none. `/dev` sorts between `/beta`
    // and `/zeta`, and the cursor is the last path returned.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = view.listPage("/", {
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const entry of page.entries) seen.push(entry.path);
      cursor = page.nextCursor ?? undefined;
      if (cursor === undefined) break;
    }
    expect(seen).toEqual(["/alpha", "/beta", "/dev", "/zeta"]);
  });

  it("keeps reserved root entries within a find result limit", async () => {
    const fileSystem = createTestFileSystem();
    await fileSystem.mkdir("/zeta");
    const view = new ReservedPathFileSystem(
      new ScopedFileSystem(fileSystem, {}, new ExecutionBudget(DEFAULT_SHELL_LIMITS, Date.now)),
    );

    expect(view.find({ path: "/", maxDepth: 1, limit: 1 })).toHaveLength(1);
  });

  it("does not repeat a reserved root while filtered pages advance", async () => {
    const fileSystem = createTestFileSystem();
    for (const name of ["alpha", "beta", "zeta"]) await fileSystem.mkdir(`/${name}`);
    const view = new ReservedPathFileSystem(
      new ScopedFileSystem(fileSystem, {}, new ExecutionBudget(DEFAULT_SHELL_LIMITS, Date.now)),
    );
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let guard = 0; guard < 20; guard += 1) {
      const page = view.findPage({
        path: "/",
        name: "dev",
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.entries.map((entry) => entry.path));
      cursor = page.nextCursor ?? undefined;
      if (cursor === undefined) break;
    }

    expect(seen).toEqual(["/dev"]);
  });

  it("honors page limits and cursors inside a reserved directory", () => {
    const fileSystem = createTestFileSystem();
    const view = new ReservedPathFileSystem(
      new ScopedFileSystem(fileSystem, {}, new ExecutionBudget(DEFAULT_SHELL_LIMITS, Date.now)),
    );
    const expected = view.list("/dev").map((entry) => entry.path);
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let guard = 0; guard < 20; guard += 1) {
      const page = view.listPage("/dev", {
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(page.entries.length).toBeLessThanOrEqual(1);
      seen.push(...page.entries.map((entry) => entry.path));
      cursor = page.nextCursor ?? undefined;
      if (cursor === undefined) break;
    }

    expect(seen).toEqual(expected);
  });

  it("honors find-page limits and cursors inside a reserved directory", () => {
    const fileSystem = createTestFileSystem();
    const view = new ReservedPathFileSystem(
      new ScopedFileSystem(fileSystem, {}, new ExecutionBudget(DEFAULT_SHELL_LIMITS, Date.now)),
    );
    const options = { path: "/dev", type: "file" as const };
    const expected = view.find(options).map((entry) => entry.path);
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let guard = 0; guard < 20; guard += 1) {
      const page = view.findPage({
        ...options,
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(page.entries.length).toBeLessThanOrEqual(1);
      seen.push(...page.entries.map((entry) => entry.path));
      cursor = page.nextCursor ?? undefined;
      if (cursor === undefined) break;
    }

    expect(seen).toEqual(expected);
  });

  it("applies depth and path filters inside a reserved directory", () => {
    const fileSystem = createTestFileSystem();
    const view = new ReservedPathFileSystem(
      new ScopedFileSystem(fileSystem, {}, new ExecutionBudget(DEFAULT_SHELL_LIMITS, Date.now)),
    );

    expect(
      view.find({ path: "/dev", includeRoot: true, maxDepth: 0 }).map((entry) => entry.path),
    ).toEqual(["/dev"]);
    expect(view.find({ path: "/dev", pathGlob: "/dev/stdout" }).map((entry) => entry.path)).toEqual(
      ["/dev/stdout"],
    );
  });

  it("summarizes nested entries in a reserved subtree", () => {
    const fileSystem = createTestFileSystem();
    const view = new ReservedPathFileSystem(
      new ScopedFileSystem(fileSystem, {}, new ExecutionBudget(DEFAULT_SHELL_LIMITS, Date.now)),
    );

    expect(view.subtreeSummary("/dev")).toEqual({
      entries: view.find({ path: "/dev", includeRoot: true }).length,
      inlineBytes: 0,
      logicalFileBytes: 0,
    });
  });

  it("honors find limits and starting cursors inside a reserved directory", () => {
    const fileSystem = createTestFileSystem();
    const view = new ReservedPathFileSystem(
      new ScopedFileSystem(fileSystem, {}, new ExecutionBudget(DEFAULT_SHELL_LIMITS, Date.now)),
    );

    const first = view.find({ path: "/dev", type: "file", limit: 1 });
    expect(first).toHaveLength(1);
    const second = view.find({
      path: "/dev",
      type: "file",
      cursor: first[0]?.path ?? "",
      limit: 1,
    });
    expect(second).toHaveLength(1);
    expect(second[0]?.path).not.toBe(first[0]?.path);
  });

  it("lists the applet directories that resolve commands", async () => {
    const harness = createBashHarness();
    // `which cat` answering `/bin/cat` and `ls /bin` showing it are the same
    // fact; a path that resolves has to be a path you can see.
    const listed = (await harness.run("ls /bin")).stdout.trim().split("\n");
    expect(listed).toContain("cat");
    expect(listed).toContain("grep");
    expect((await harness.run("ls /usr")).stdout).toBe("bin\n");
    expect((await harness.run("ls /usr/bin")).stdout).toBe(`${listed.join("\n")}\n`);

    // Only what actually resolves as a path. A session built-in has no program
    // form, so listing `/bin/cd` would advertise a command that exits 127.
    expect(listed).not.toContain("cd");
    expect(listed).not.toContain("export");
    // And `.` is a real applet whose path spelling collapses onto the
    // directory itself, so it cannot be an entry in it.
    expect(listed).not.toContain(".");
    expect((await harness.run("/bin/echo runs")).stdout).toBe("runs\n");
  });

  it("reports an applet path as an executable file with no content", async () => {
    const harness = createBashHarness();
    expect((await harness.run("stat -c '%F %a %s' /bin/cat")).stdout).toBe("regular file 755 0\n");
    expect((await harness.run("[ -x /bin/cat ] && echo executable")).stdout).toBe("executable\n");
    expect((await harness.run("[ -f /bin/cat ] && echo file")).stdout).toBe("file\n");
    expect((await harness.run("[ -d /bin ] && echo directory")).stdout).toBe("directory\n");
    // There is no file behind it, and saying so beats returning nothing and
    // letting that read as an empty one.
    const read = await harness.run("cat /bin/cat");
    expect(read.exitCode).not.toBe(0);
    expect(read.stderr).toContain("no file content");
  });

  it("reserves the applet directories against change", async () => {
    const harness = createBashHarness();
    // The reason #46 kept these out of the namespace was that a row there
    // could be removed while `/bin/cat` kept working. Reserving them answers
    // that without making the directory invisible.
    for (const script of [
      "rm -r /bin",
      "rm /bin/cat",
      "mkdir /bin/x",
      "touch /usr/bin/y",
      "mkdir /usr",
    ]) {
      const result = await harness.run(script);
      expect(result.exitCode, script).not.toBe(0);
      expect(result.stderr, script).toContain("is reserved and cannot be changed");
    }
  });

  it("keeps devices out of the namespace", async () => {
    const harness = createBashHarness();
    // Using one creates nothing: `/dev` is shown because it is a directory
    // that answers, not because a row appeared behind it.
    expect((await harness.run("echo x > /dev/null; ls /")).stdout).toBe("bin\ndev\nusr\n");
    expect(() => harness.fileSystem.stat("/dev/null")).toThrowError(/no such file or directory/u);
    expect(() => harness.fileSystem.stat("/dev")).toThrowError(/no such file or directory/u);
  });
});

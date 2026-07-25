import { describe, expect, it } from "vitest";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { Shell } from "../src/shell/shell.js";
import { bashCases, createBashHarness } from "./helpers/bash.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

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
      name: "reports a device the way the oracle does",
      script:
        "[ -e /dev/null ] && printf 'e'; [ -f /dev/null ] || printf ' not-f'; " +
        "[ -r /dev/null ] && printf ' r'; [ -w /dev/null ] && printf ' w'; " +
        "[ -d /dev/null ] || printf ' not-d'; printf '\\n'; stat -c '%F %s' /dev/null; " +
        "file /dev/null; ls -d /dev/null; ls -l /dev/null",
      stdout:
        "e not-f r w not-d\ncharacter special file 0\n/dev/null: character special file\n" +
        "/dev/null\ncrw-rw-rw-        0 /dev/null\n",
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

  it("charges discarded bytes to the I/O budget", async () => {
    const run = async (limit: number, target: string): Promise<number> => {
      const harness = createBashHarness({ limits: { maxTotalIoBytes: limit } });
      await harness.fileSystem.writeFile("/big.txt", "x".repeat(16384));
      return (await harness.run(`cat /big.txt > ${target}`)).exitCode;
    };
    // Discarding is not a way to move bytes for free: the same budget that
    // refuses writing them to a file refuses throwing them away, and the same
    // budget that allows it allows both.
    expect(await run(4096, "/dev/null")).not.toBe(0);
    expect(await run(4096, "/out.txt")).not.toBe(0);
    expect(await run(1_000_000, "/dev/null")).toBe(0);
    expect(await run(1_000_000, "/out.txt")).toBe(0);
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
    const running = harness.run("sleep 20 > /dev/null; echo finished", {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    const result = await running;
    expect(result.stdout).toBe("");
    expect(result.exitCode).not.toBe(0);
  });

  it("applies the declared roots to a device rather than exempting it", async () => {
    const scoped = createBashHarness({ policy: { readRoots: ["/w"], writeRoots: ["/w"] } });
    await scoped.fileSystem.mkdir("/w", true);
    const denied = await scoped.run("echo hi > /dev/null");
    expect(denied.exitCode).toBe(126);
    expect(denied.stderr).toContain("outside the writable roots");

    // A session that wants the devices lists them, like any other path.
    const allowed = createBashHarness({
      policy: { readRoots: ["/w", "/dev"], writeRoots: ["/w", "/dev"] },
    });
    await allowed.fileSystem.mkdir("/w", true);
    expect((await allowed.run("echo hi > /dev/null; echo ok")).stdout).toBe("ok\n");
  });

  it("keeps devices out of the namespace", async () => {
    const harness = createBashHarness();
    // Nothing was created by using one, and nothing lists one.
    expect((await harness.run("echo x > /dev/null; ls /")).stdout).toBe("");
    expect(() => harness.fileSystem.stat("/dev/null")).toThrowError(/no such file or directory/u);
    expect(() => harness.fileSystem.stat("/dev")).toThrowError(/no such file or directory/u);
  });
});

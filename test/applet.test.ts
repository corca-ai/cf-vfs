import { describe, expect, it } from "vitest";
import {
  APPLET_DIRECTORIES,
  type AppletSpec,
  appletPathName,
  appletUsageError,
  createAppletRegistry,
  defineApplet,
  formatAppletUsage,
  type ShellApplet,
} from "../src/shell/commands/applet.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { writeText } from "../src/shell/commands/helpers.js";
import { bashCases, createBashHarness } from "./helpers/bash.js";

function marker(name: string, aliases?: readonly string[]): ShellApplet {
  const spec: AppletSpec = {
    name,
    usage: "",
    summary: `writes ${name}`,
    ...(aliases === undefined ? {} : { aliases }),
  };
  return defineApplet(spec, async (_context, _argv, fds) => {
    await writeText(fds[1], `${name}\n`);
    return 0;
  });
}

describe("applet specifications", () => {
  it("publishes a unique, non-empty specification for every default applet", () => {
    const seen = new Set<string>();
    for (const command of defaultShellCommands) {
      const spec = (command as Partial<ShellApplet>).spec;
      expect(spec, command.name).toBeDefined();
      if (spec === undefined) continue;
      expect(spec.name).toBe(command.name);
      expect(spec.summary.length).toBeGreaterThan(0);
      // A summary is a fragment inside a help table, not a sentence.
      expect(spec.summary).toBe(spec.summary.trim());
      expect(spec.summary.endsWith(".")).toBe(false);
      expect(spec.usage).toBe(spec.usage.trim());
      for (const name of [spec.name, ...(spec.aliases ?? [])]) {
        expect(seen.has(name), name).toBe(false);
        seen.add(name);
      }
    }
  });

  it("renders a usage synopsis with and without operands", () => {
    expect(formatAppletUsage({ name: "pwd", usage: "", summary: "prints the directory" })).toBe(
      "usage: pwd",
    );
    expect(formatAppletUsage({ name: "cat", usage: "[FILE...]", summary: "concatenates" })).toBe(
      "usage: cat [FILE...]",
    );
  });

  it("prefixes a usage diagnostic with the canonical name", () => {
    const error = appletUsageError({ name: "mkdir", usage: "", summary: "creates" }, "missing");
    expect(error.code).toBe("EINVAL");
    expect(error.message).toBe("mkdir: missing");
  });
});

describe("virtual applet paths", () => {
  it("maps only the declared applet directories to a bare name", () => {
    expect(APPLET_DIRECTORIES).toEqual(["/bin", "/usr/bin"]);
    expect(appletPathName("/bin/cat")).toBe("cat");
    expect(appletPathName("/usr/bin/find")).toBe("find");
    for (const rejected of [
      "cat",
      "./cat",
      "../bin/cat",
      "/sbin/cat",
      "/usr/local/bin/cat",
      "/bin/nested/cat",
      "/bin/",
      "/bin/.",
      "/bin/..",
      "/usr/bin/../bin/cat",
      "",
    ]) {
      expect(appletPathName(rejected), rejected).toBeUndefined();
    }
  });
});

describe("applet registry", () => {
  it("resolves a canonical name, an alias, and a virtual path to one implementation", () => {
    const applet = marker("hello", ["hi"]);
    const registry = createAppletRegistry([applet]);
    for (const spelling of ["hello", "hi", "/bin/hello", "/usr/bin/hi"]) {
      expect(registry.lookup(spelling), spelling).toBe(applet);
    }
    expect(registry.lookup("/sbin/hello")).toBeUndefined();
    expect(registry.lookup("missing")).toBeUndefined();
    expect(registry.commands).toEqual([applet]);
  });

  it("rejects a duplicate canonical name, alias, or alias/name collision", () => {
    expect(() => createAppletRegistry([marker("dup"), marker("dup")])).toThrowError(
      /duplicate command: dup/u,
    );
    expect(() =>
      createAppletRegistry([marker("one", ["shared"]), marker("two", ["shared"])]),
    ).toThrowError(/duplicate command: shared/u);
    expect(() => createAppletRegistry([marker("one"), marker("two", ["one"])])).toThrowError(
      /duplicate command: one/u,
    );
  });

  it("ignores a prototype-shaped spelling", () => {
    const registry = createAppletRegistry([marker("safe")]);
    for (const spelling of ["__proto__", "constructor", "toString", "/bin/__proto__"]) {
      expect(registry.lookup(spelling), spelling).toBeUndefined();
    }
  });

  it("accepts a plain ShellCommand without a specification", () => {
    const plain = { name: "plain", run: () => ({ completed: Promise.resolve({ exitCode: 0 }) }) };
    expect(createAppletRegistry([plain]).lookup("/bin/plain")).toBe(plain);
  });
});

describe("multicall dispatch in the shell", () => {
  bashCases([
    {
      name: "runs an applet through /bin",
      script: "/bin/echo hello",
      stdout: "hello\n",
    },
    {
      name: "runs an applet through /usr/bin",
      script: "/usr/bin/printf '%s' body",
      stdout: "body",
    },
    {
      name: "reports the canonical name in a usage diagnostic",
      script: "/usr/bin/mkdir",
      exitCode: 2,
      stderr: "mkdir: missing operand\n",
    },
    {
      name: "leaves other absolute paths not found",
      script: "/sbin/echo hello",
      exitCode: 127,
      stderr: "/sbin/echo: command not found\n",
    },
    {
      name: "does not let a VFS file shadow an applet path",
      files: { "/bin/echo": "#!/bin/sh\nexit 9\n" },
      script: "/bin/echo shadowed",
      stdout: "shadowed\n",
    },
    {
      name: "prefers a shell function over an applet spelling",
      script: ["echo() { printf 'function\\n'; }", "echo ignored", "/bin/echo builtin"],
      stdout: "function\nbuiltin\n",
    },
  ]);

  it("applies the command allowlist to the canonical name", async () => {
    const harness = createBashHarness({ policy: { allowedCommands: ["echo"] } });
    const allowed = await harness.run("/bin/echo permitted");
    expect(allowed.exitCode).toBe(0);
    expect(allowed.stdout).toBe("permitted\n");

    const denied = await harness.run("/usr/bin/cat /nowhere");
    expect(denied.exitCode).toBe(126);
    expect(denied.stderr).toBe("command is not allowed: cat\n");
  });
});

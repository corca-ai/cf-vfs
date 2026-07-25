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

/**
 * The exact convenience preset. A command silently dropped from
 * `defaultShellCommands` would otherwise pass every other gate: bundle presets
 * name only a sample of applets as markers, and the byte budget has slack.
 */
const DEFAULT_REGISTRY = [
  ".",
  ":",
  "[",
  "base64",
  "basename",
  "break",
  "cat",
  "cd",
  "chmod",
  "cmp",
  "comm",
  "command",
  "continue",
  "cp",
  "cut",
  "date",
  "diff",
  "dirname",
  "du",
  "echo",
  "env",
  "exit",
  "export",
  "expr",
  "false",
  "file",
  "find",
  "fold",
  "getopts",
  "grep",
  "head",
  "help",
  "join",
  "local",
  "ls",
  "mkdir",
  "mktemp",
  "mv",
  "nl",
  "paste",
  "patch",
  "printenv",
  "printf",
  "pwd",
  "read",
  "realpath",
  "return",
  "rm",
  "rmdir",
  "sed",
  "seq",
  "set",
  "sh",
  "sha256sum",
  "shift",
  "sleep",
  "sort",
  "source",
  "stat",
  "tail",
  "tee",
  "test",
  "touch",
  "tr",
  "tree",
  "true",
  "type",
  "uniq",
  "unset",
  "wc",
  "which",
  "xargs",
] as const;

describe("applet specifications", () => {
  it("registers exactly the documented convenience preset", () => {
    expect(defaultShellCommands.map((command) => command.name).sort()).toEqual([
      ...DEFAULT_REGISTRY,
    ]);
  });

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
      expect(spec.summary[0]).toBe(spec.summary[0]?.toLowerCase());
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

  it("names the applet and ends a usage diagnostic with its synopsis", () => {
    const spec: AppletSpec = { name: "mkdir", usage: "[-p] DIRECTORY...", summary: "creates" };
    const error = appletUsageError(spec, "missing operand");
    expect(error.code).toBe("EINVAL");
    expect(error.message).toBe("mkdir: missing operand\nusage: mkdir [-p] DIRECTORY...");
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
      "/bin//cat",
      "//bin/cat",
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
    for (const spelling of ["hello", "hi"]) {
      expect(registry.find(spelling)?.command, spelling).toBe(applet);
    }
    for (const spelling of ["/bin/hello", "/usr/bin/hi"]) {
      expect(registry.findPath(spelling)?.command, spelling).toBe(applet);
    }
    expect(registry.findPath("/sbin/hello")).toBeUndefined();
    expect(registry.find("missing")).toBeUndefined();
    // The directory match is literal, so a duplicated separator fails closed.
    expect(registry.findPath("/bin//hello")).toBeUndefined();
    expect(registry.isAppletDirectory("/bin")).toBe(true);
    expect(registry.isAppletDirectory("/bin/")).toBe(false);
    expect(registry.isAppletDirectory("/opt")).toBe(false);
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
    for (const spelling of ["__proto__", "constructor", "toString"]) {
      expect(registry.find(spelling), spelling).toBeUndefined();
    }
    expect(registry.findPath("/bin/__proto__")).toBeUndefined();
  });

  it("keeps a session-scoped built-in out of the virtual applet directories", () => {
    const registry = createAppletRegistry(defaultShellCommands);
    for (const builtin of ["cd", "export", "set", "source", "local", "exit", "command", "type"]) {
      expect(registry.find(builtin)?.kind, builtin).toBe("session-builtin");
      expect(registry.findPath(`/bin/${builtin}`), builtin).toBeUndefined();
      expect(registry.findPath(`/usr/bin/${builtin}`), builtin).toBeUndefined();
    }
    // A built-in Linux also ships as a program keeps both spellings.
    for (const program of ["printf", "echo", "test", "true", "pwd"]) {
      expect(registry.find(program)?.kind, program).toBe("builtin");
      expect(registry.findPath(`/bin/${program}`)?.command, program).toBe(
        registry.find(program)?.command,
      );
    }
    for (const program of ["cat", "ls", "grep", "env", "which", "sh"]) {
      expect(registry.find(program)?.kind, program).toBe("program");
      expect(registry.findPath(`/bin/${program}`)?.command, program).toBe(
        registry.find(program)?.command,
      );
    }
  });

  it("snapshots the registered commands so later mutation cannot desynchronize lookup", () => {
    const commands = [marker("first")];
    const registry = createAppletRegistry(commands);
    commands.push(marker("second"));
    expect(registry.commands).toHaveLength(1);
    expect(registry.find("second")).toBeUndefined();
  });

  it("accepts a plain ShellCommand without a specification", () => {
    const plain = { name: "plain", run: () => ({ completed: Promise.resolve({ exitCode: 0 }) }) };
    const registry = createAppletRegistry([plain]);
    expect(registry.find("plain")).toEqual({ command: plain, kind: "program" });
    expect(registry.findPath("/bin/plain")?.command).toBe(plain);
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
      name: "reports the canonical name and synopsis in a usage diagnostic",
      script: "/usr/bin/mkdir",
      exitCode: 2,
      stderr: "mkdir: missing operand\nusage: mkdir [-p] [-m MODE] DIRECTORY...\n",
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

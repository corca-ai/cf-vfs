import { describe, expect, it } from "vitest";
import { createAppletRegistry, splitSearchPath } from "../src/shell/commands/applet.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import {
  LINUX_APPLET_DIRECTORIES,
  LINUX_DATA_DIRECTORIES,
  LINUX_SHELL_PATH,
  LINUX_WORKSPACE,
  linuxShellEnvironment,
  provisionLinuxFilesystem,
} from "../src/shell/linux.js";
import { bashCases, createBashHarness } from "./helpers/bash.js";

const PATH = LINUX_APPLET_DIRECTORIES.join(":");

describe("PATH resolution", () => {
  const registry = createAppletRegistry(defaultShellCommands);

  it("splits components without collapsing empty or duplicated entries", () => {
    expect(splitSearchPath("/bin:/usr/bin")).toEqual(["/bin", "/usr/bin"]);
    expect(splitSearchPath("")).toEqual([""]);
    expect(splitSearchPath("/bin::/bin")).toEqual(["/bin", "", "/bin"]);
  });

  it("resolves every applet by bare name when no PATH is set", () => {
    expect(registry.resolve("cat")).toEqual({ command: registry.lookup("cat"), kind: "program" });
    expect(registry.resolve("cd")).toEqual({ command: registry.lookup("cd"), kind: "builtin" });
    expect(registry.resolve("echo")).toEqual({ command: registry.lookup("echo"), kind: "builtin" });
  });

  it("reports the first applet directory on PATH", () => {
    expect(registry.resolve("cat", PATH)?.path).toBe("/bin/cat");
    expect(registry.resolve("cat", "/usr/bin:/bin")?.path).toBe("/usr/bin/cat");
    // A duplicated component is harmless; the first match still decides.
    expect(registry.resolve("cat", "/usr/bin:/usr/bin:/bin")?.path).toBe("/usr/bin/cat");
    // Components that name nothing resolvable are skipped, not fatal.
    expect(registry.resolve("cat", ":/opt/tools:/bin")?.path).toBe("/bin/cat");
  });

  it("finds no applet when PATH names no applet directory", () => {
    for (const searchPath of ["", "/opt/tools", "/bin/", "/usr/local/bin", ":"]) {
      expect(registry.resolve("cat", searchPath), searchPath).toBeUndefined();
    }
  });

  it("keeps built-ins reachable regardless of PATH", () => {
    for (const searchPath of ["", "/opt/tools", PATH]) {
      expect(registry.resolve("cd", searchPath), searchPath).toEqual({
        command: registry.lookup("cd"),
        kind: "builtin",
      });
    }
    // A built-in that Linux also ships as a program keeps its applet path.
    expect(registry.resolve("echo", "")).toEqual({
      command: registry.lookup("echo"),
      kind: "builtin",
    });
    expect(registry.resolve("echo", PATH)).toEqual({
      command: registry.lookup("echo"),
      kind: "builtin",
      path: "/bin/echo",
    });
  });

  it("lets an absolute applet path bypass PATH entirely", () => {
    expect(registry.resolve("/bin/cat", "")?.path).toBe("/bin/cat");
    expect(registry.resolve("/usr/bin/cat", "/opt/tools")?.path).toBe("/usr/bin/cat");
    // A built-in has no program spelling, on PATH or off it.
    expect(registry.resolve("/bin/cd", PATH)).toBeUndefined();
  });
});

describe("PATH resolution in the shell", () => {
  bashCases([
    {
      name: "runs an applet found through PATH",
      script: "PATH=/bin cat /file",
      files: { "/file": "body" },
      stdout: "body",
    },
    {
      name: "reports command not found when PATH names no applet directory",
      script: "PATH=/opt/tools cat /file",
      files: { "/file": "body" },
      exitCode: 127,
      stderr: "cat: command not found\n",
    },
    {
      name: "keeps built-ins available with an empty PATH",
      script: ["PATH=", "cd /", "pwd", "echo builtin", "test -d / && printf 'ok\\n'"],
      stdout: "/\nbuiltin\nok\n",
    },
    {
      name: "does not find an ordinary applet with an empty PATH",
      script: ["PATH=", "cat /file"],
      files: { "/file": "body" },
      exitCode: 127,
      stderr: "cat: command not found\n",
    },
    {
      name: "still accepts an absolute applet path with an empty PATH",
      script: ["PATH=", "/bin/echo direct"],
      stdout: "direct\n",
    },
    {
      name: "applies PATH only to the command it prefixes",
      script: ["PATH=/opt/tools echo prefixed", "echo after"],
      stdout: "prefixed\nafter\n",
    },
  ]);

  it("denies a PATH-resolved applet the policy does not allow", async () => {
    const harness = createBashHarness({ policy: { allowedCommands: ["echo"] } });
    const result = await harness.run(`PATH=${PATH} cat /nowhere`);
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toBe("command is not allowed: cat\n");
  });
});

describe("command discovery", () => {
  bashCases([
    {
      name: "command -v prints the applet path found on PATH",
      script: `PATH=${PATH}; command -v cat`,
      stdout: "/bin/cat\n",
    },
    {
      name: "command -v prints a bare name for a built-in",
      script: "command -v cd",
      stdout: "cd\n",
    },
    {
      name: "command -v prints a bare name for a function",
      script: ["deploy() { true; }", "command -v deploy"],
      stdout: "deploy\n",
    },
    {
      name: "command -v fails quietly for an unknown name",
      script: "command -v nonexistent || printf 'status=%s\\n' \"$?\"",
      stdout: "status=1\n",
    },
    {
      name: "command runs an applet in spite of a shadowing function",
      script: ["echo() { printf 'wrapped\\n'; }", "echo once", "command echo twice"],
      stdout: "wrapped\ntwice\n",
    },
    {
      name: "type distinguishes functions, built-ins, and applets",
      script: [`PATH=${PATH}`, "deploy() { true; }", "type deploy cd echo cat"],
      stdout:
        "deploy is a function\ncd is a shell builtin\necho is a shell builtin\ncat is /bin/cat\n",
    },
    {
      name: "type reports an applet without a path when nothing was searched",
      script: "type cat",
      stdout: "cat is a cf-vfs applet\n",
    },
    {
      name: "type reports an unknown name on stderr with status 1",
      script: "type nonexistent",
      exitCode: 1,
      stderr: "type: nonexistent: not found\n",
    },
    {
      name: "which prints applet paths and skips built-ins",
      script: `PATH=${PATH}; which cat grep || printf 'status=%s\\n' "$?"`,
      stdout: "/bin/cat\n/bin/grep\n",
    },
    {
      name: "which does not find a session-scoped built-in",
      script: `PATH=${PATH}; which cd || printf 'status=%s\\n' "$?"`,
      stdout: "status=1\n",
    },
    {
      name: "which finds a built-in that Linux also ships as a program",
      script: `PATH=${PATH}; which echo`,
      stdout: "/bin/echo\n",
    },
    {
      name: "printenv prints one value per name",
      script: "printenv HOME SHELL",
      env: { HOME: "/home/cf", SHELL: "/bin/sh" },
      stdout: "/home/cf\n/bin/sh\n",
    },
    {
      name: "printenv reports status 1 for an unset name",
      script: "printenv MISSING || printf 'status=%s\\n' \"$?\"",
      stdout: "status=1\n",
    },
    {
      name: "printenv rejects an unsupported option",
      script: "printenv -0",
      exitCode: 2,
      stderrIncludes: "printenv: unsupported option -0",
    },
  ]);
});

describe("Linux filesystem profile", () => {
  it("publishes environment defaults naming the applet directories", () => {
    const environment = linuxShellEnvironment();
    expect(environment).toEqual({
      PATH: "/bin:/usr/bin",
      HOME: "/home/cf",
      USER: "cf",
      LOGNAME: "cf",
      SHELL: LINUX_SHELL_PATH,
      TMPDIR: "/tmp",
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
    });
    expect(linuxShellEnvironment({ user: "agent" })).toMatchObject({
      USER: "agent",
      LOGNAME: "agent",
      HOME: "/home/agent",
    });
    expect(linuxShellEnvironment({ home: "/srv/app", tmp: "/var/tmp" })).toMatchObject({
      HOME: "/srv/app",
      TMPDIR: "/var/tmp",
    });
  });

  it("creates only data directories, never an applet directory", async () => {
    const harness = createBashHarness();
    const created = provisionLinuxFilesystem(harness.fileSystem);
    expect(created.map((stat) => stat.path)).toEqual([
      ...LINUX_DATA_DIRECTORIES,
      "/home/cf",
      LINUX_WORKSPACE,
    ]);
    for (const path of LINUX_DATA_DIRECTORIES) {
      expect(harness.fileSystem.stat(path).kind, path).toBe("directory");
    }
    for (const path of LINUX_APPLET_DIRECTORIES) {
      expect(() => harness.fileSystem.stat(path), path).toThrowError(
        expect.objectContaining({ code: "ENOENT" }),
      );
    }
  });

  it("is idempotent", () => {
    const harness = createBashHarness();
    provisionLinuxFilesystem(harness.fileSystem);
    expect(() => provisionLinuxFilesystem(harness.fileSystem)).not.toThrow();
  });

  it("runs a familiar script end to end", async () => {
    const harness = createBashHarness();
    provisionLinuxFilesystem(harness.fileSystem);
    const result = await harness.run(
      [
        "cd $HOME",
        "printf 'one\\ntwo\\n' > notes.txt",
        "grep two notes.txt",
        'printf \'%s %s\\n\' "$(pwd)" "$(command -v grep)"',
      ],
      { env: linuxShellEnvironment(), cwd: LINUX_WORKSPACE },
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("two\n/home/cf /bin/grep\n");
  });
});

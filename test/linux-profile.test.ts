import { describe, expect, it } from "vitest";
import {
  createAppletRegistry,
  defineApplet,
  splitSearchPath,
} from "../src/shell/commands/applet.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import {
  LINUX_APPLET_DIRECTORIES,
  LINUX_DATA_DIRECTORIES,
  LINUX_PROFILE_VARIABLES,
  LINUX_SHELL_PATH,
  LINUX_WORKSPACE,
  linuxShellEnvironment,
  provisionLinuxFilesystem,
} from "../src/shell/linux.js";
import { bashCases, createBashHarness } from "./helpers/bash.js";

const PATH = LINUX_APPLET_DIRECTORIES.join(":");

describe("PATH components", () => {
  const registry = createAppletRegistry(defaultShellCommands);

  it("returns components exactly as written", () => {
    expect(splitSearchPath("/bin:/usr/bin")).toEqual(["/bin", "/usr/bin"]);
    expect(splitSearchPath("")).toEqual([""]);
    expect(splitSearchPath("/bin::/bin")).toEqual(["/bin", "", "/bin"]);
  });

  it("recognizes only the exact applet directory spellings", () => {
    for (const directory of LINUX_APPLET_DIRECTORIES) {
      expect(registry.isAppletDirectory(directory), directory).toBe(true);
    }
    // A component must be spelled exactly; a trailing slash is a different
    // string and no namespace directory can supply a command yet.
    for (const directory of ["", "/bin/", "/opt/tools", "/usr/local/bin", "/BIN", "bin"]) {
      expect(registry.isAppletDirectory(directory), directory).toBe(false);
    }
  });

  it("classifies each applet kind", () => {
    expect(registry.find("cat")?.kind).toBe("program");
    expect(registry.find("echo")?.kind).toBe("builtin");
    expect(registry.find("cd")?.kind).toBe("session-builtin");
  });
});

type HarnessOptions = Parameters<typeof createBashHarness>[0];

/** Every case in this file exercises the opt-in `PATH` search. */
function pathHarness(options: HarnessOptions = {}) {
  return createBashHarness({ commandResolution: "path", ...options });
}

function pathCases(cases: Parameters<typeof bashCases>[0]): void {
  bashCases(cases, { commandResolution: "path" });
}

describe("PATH resolution in the shell", () => {
  pathCases([
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
    const harness = pathHarness({ policy: { allowedCommands: ["echo", "printf"] } });
    const result = await harness.run(`PATH=${PATH} cat /nowhere`);
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toBe("command is not allowed: cat\n");
  });

  it("leaves a prefix assignment undone when the policy denies the command", async () => {
    const harness = pathHarness({ policy: { allowedCommands: ["printf"] } });
    const result = await harness.run(["X=1 export X 2>/dev/null", "printf '[%s]' \"${X-unset}\""]);
    expect(result.stdout).toBe("[unset]");
  });

  it("leaves a prefix assignment undone when a function shadows export", async () => {
    const harness = createBashHarness();
    const result = await harness.run([
      "export() { printf 'fn'; }",
      "X=1 export X",
      "printf '[%s]' \"${X-unset}\"",
    ]);
    expect(result.stdout).toBe("fn[unset]");
  });

  it("ignores PATH entirely under the default resolution mode", async () => {
    const harness = createBashHarness();
    const result = await harness.run("PATH=/opt/tools cat /file", {});
    // The default keeps every registered applet reachable, so an application
    // that sets PATH for its own reasons cannot lose commands.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no such file or directory");
  });

  it("resolves an alias through a PATH search", async () => {
    const registry = createAppletRegistry([
      defineApplet({ name: "canonical", aliases: ["alias"], usage: "", summary: "probe" }, () => 0),
    ]);
    expect(registry.find("alias")?.command).toBe(registry.find("canonical")?.command);
    expect(registry.findPath("/bin/alias")?.command).toBe(registry.find("canonical")?.command);
  });
});

describe("command discovery", () => {
  pathCases([
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

it("declares the shell profile as a name that resolves and runs", async () => {
  const harness = pathHarness();
  const named = await harness.run(`PATH=${PATH}; command -v sh; type bash`);
  expect(named.exitCode).toBe(0);
  // An alias reports the spelling that was asked for, as Linux would.
  expect(named.stdout).toBe("/bin/sh\nbash is /bin/bash\n");
  const run = await harness.run(`PATH=${PATH}; /bin/sh -c 'printf %s ran'`);
  expect(run.exitCode).toBe(0);
  expect(run.stdout).toBe("ran");
});

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

it("names exactly the variables it controls", () => {
  expect([...LINUX_PROFILE_VARIABLES].sort()).toEqual(Object.keys(linuxShellEnvironment()).sort());
});

it("lets a caller override a profile value", async () => {
  const harness = pathHarness();
  const result = await harness.run('printf \'%s|%s\' "$USER" "$HOME"', {
    env: { ...linuxShellEnvironment(), USER: "agent" },
  });
  expect(result.stdout).toBe("agent|/home/cf");
});

it("creates only data directories, never an applet directory", async () => {
  const harness = createBashHarness();
  const created = provisionLinuxFilesystem(harness.fileSystem);
  expect(created.map((stat) => stat.path)).toEqual([...LINUX_DATA_DIRECTORIES, "/home/cf"]);
  for (const path of LINUX_DATA_DIRECTORIES) {
    expect(harness.fileSystem.stat(path).kind, path).toBe("directory");
  }
  for (const path of LINUX_APPLET_DIRECTORIES) {
    expect(() => harness.fileSystem.stat(path), path).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
  }
});

it("is idempotent and creates each directory once", () => {
  const harness = createBashHarness();
  const created = provisionLinuxFilesystem(harness.fileSystem);
  expect(new Set(created.map((stat) => stat.path)).size).toBe(created.length);
  expect(() => provisionLinuxFilesystem(harness.fileSystem)).not.toThrow();
});

it("refuses to create a namespace row inside a virtual applet directory", () => {
  const harness = createBashHarness();
  for (const options of [{ cwd: "/bin" }, { home: "/usr/bin/agent" }]) {
    expect(() => provisionLinuxFilesystem(harness.fileSystem, options)).toThrowError(
      /virtual applet directory/u,
    );
  }
});

it("runs a familiar script end to end", async () => {
  const harness = pathHarness();
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

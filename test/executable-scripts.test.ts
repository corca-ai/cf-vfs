import { describe, expect, it } from "vitest";
import {
  ENV_INTERPRETER_NAMES,
  isExecutableMode,
  MAX_SHEBANG_BYTES,
  readShebangLine,
  SHELL_INTERPRETERS,
  SHELL_PROFILE_COMMAND,
  selectsShellProfile,
} from "../src/shell/script.js";
import { type BashCase, bashCases, createBashHarness } from "./helpers/bash.js";

const EXECUTABLE = 0o100755;
const encoder = new TextEncoder();

function scriptCases(cases: readonly BashCase[]): void {
  bashCases(cases, { commandResolution: "path" });
}

/** Writes files and marks the listed ones executable. */
async function withScripts(
  files: Readonly<Record<string, string>>,
  executable: readonly string[],
  options: Parameters<typeof createBashHarness>[0] = {},
) {
  const harness = createBashHarness({ commandResolution: "path", ...options });
  for (const [path, body] of Object.entries(files)) {
    await harness.fileSystem.writeFile(path, body, { createParents: true });
  }
  for (const path of executable) harness.fileSystem.setMetadata(path, { mode: EXECUTABLE });
  return harness;
}

describe("shebang scanning", () => {
  it("reads an interpreter line from the byte prefix", () => {
    expect(readShebangLine(encoder.encode("#!/bin/sh\nbody\n")).line).toBe("/bin/sh");
    expect(readShebangLine(encoder.encode("#!/bin/sh -\r\nbody\n")).line).toBe("/bin/sh -");
    expect(readShebangLine(encoder.encode("#!/bin/sh")).line).toBe("/bin/sh");
    expect(readShebangLine(encoder.encode("body\n")).line).toBeUndefined();
    expect(readShebangLine(encoder.encode("#not a shebang\n")).line).toBeUndefined();
    expect(readShebangLine(new Uint8Array()).line).toBeUndefined();
    expect(readShebangLine(encoder.encode("#")).line).toBeUndefined();
  });

  it("refuses a line that is too long or not ASCII", () => {
    const long = encoder.encode(`#!${"a".repeat(MAX_SHEBANG_BYTES)}\n`);
    expect(() => readShebangLine(long)).toThrowError(/exceeds 256 bytes/u);
    expect(() => readShebangLine(encoder.encode("#!/bin/café\n"))).toThrowError(/not ASCII/u);
    expect(() => readShebangLine(new Uint8Array([0x23, 0x21, 0x00, 0x0a]))).toThrowError(
      /not ASCII/u,
    );
  });

  it("accepts only the declared interpreters", () => {
    for (const interpreter of SHELL_INTERPRETERS) {
      expect(selectsShellProfile(interpreter), interpreter).toBe(true);
      expect(selectsShellProfile(`  ${interpreter}  `), interpreter).toBe(true);
    }
    for (const name of ENV_INTERPRETER_NAMES) {
      expect(selectsShellProfile(`/usr/bin/env ${name}`), name).toBe(true);
    }
    for (const rejected of [
      "",
      "   ",
      "/usr/bin/python3",
      "/bin/sh -e",
      "/bin/dash",
      "/usr/bin/env",
      "/usr/bin/env python3",
      "/usr/bin/env -S sh",
      "sh",
      "/usr/local/bin/sh",
    ]) {
      expect(selectsShellProfile(rejected), rejected).toBe(false);
    }
  });

  it("reads the executable bit from compatibility mode bits", () => {
    expect(isExecutableMode(0o100755)).toBe(true);
    expect(isExecutableMode(0o100700)).toBe(true);
    expect(isExecutableMode(0o100004)).toBe(false);
    expect(isExecutableMode(0o100644)).toBe(false);
  });
});

describe("executing an inline VFS script", () => {
  scriptCases([
    {
      name: "runs a relative path with arguments",
      files: { "/w/hello.sh": "#!/bin/sh\nprintf 'hello %s\\n' \"$1\"\n" },
      script: ["chmod 755 /w/hello.sh", "cd /w", "./hello.sh world"],
      stdout: "hello world\n",
    },
    {
      name: "runs an absolute path",
      files: { "/w/hello.sh": "#!/bin/sh\nprintf run\n" },
      script: ["chmod 755 /w/hello.sh", "/w/hello.sh"],
      stdout: "run",
    },
    {
      name: "treats a file with no shebang as a shell script",
      files: { "/w/plain.sh": "printf plain\n" },
      script: ["chmod 755 /w/plain.sh", "/w/plain.sh"],
      stdout: "plain",
    },
    {
      name: "accepts the env interpreter form",
      files: { "/w/env.sh": "#!/usr/bin/env bash\nprintf env\n" },
      script: ["chmod 755 /w/env.sh", "/w/env.sh"],
      stdout: "env",
    },
    {
      name: "passes the script path as the zeroth parameter",
      files: { "/w/zero.sh": '#!/bin/sh\nprintf \'%s|%s\' "$0" "$#"\n' },
      script: ["chmod 755 /w/zero.sh", "/w/zero.sh a b"],
      stdout: "/w/zero.sh|2",
    },
    {
      name: "reports a missing path as not found",
      script: "/w/missing.sh",
      exitCode: 127,
      stderr: "/w/missing.sh: command not found\n",
    },
    {
      name: "reports a non-executable file as not executable",
      files: { "/w/plain.sh": "printf plain\n" },
      script: "/w/plain.sh",
      exitCode: 126,
      stderr: "/w/plain.sh: is not executable\n",
    },
    {
      name: "reports a directory as not a regular file",
      files: { "/w/dir/keep": "x" },
      script: "/w/dir",
      exitCode: 126,
      stderr: "/w/dir: is not a regular file\n",
    },
    {
      name: "refuses an interpreter outside the profile",
      files: { "/w/py.sh": "#!/usr/bin/python3\nprint(1)\n" },
      script: ["chmod 755 /w/py.sh", "/w/py.sh"],
      exitCode: 126,
      stderr: "/w/py.sh: unsupported interpreter: /usr/bin/python3\n",
    },
    {
      name: "refuses an interpreter line that is not ASCII",
      files: { "/w/bad.sh": "#!/bin/café\nprintf x\n" },
      script: ["chmod 755 /w/bad.sh", "/w/bad.sh"],
      exitCode: 126,
      stderrIncludes: "interpreter line is not ASCII",
    },
    {
      name: "propagates the script status",
      files: { "/w/fail.sh": "#!/bin/sh\nexit 7\n" },
      script: ["chmod 755 /w/fail.sh", "/w/fail.sh", "printf 'after=%s' \"$?\""],
      stdout: "after=7",
    },
    {
      name: "keeps exit inside the script",
      files: { "/w/exits.sh": "#!/bin/sh\nexit 3\n" },
      script: ["chmod 755 /w/exits.sh", "/w/exits.sh", "printf still-here"],
      stdout: "still-here",
    },
    {
      name: "isolates variables, functions, and the working directory",
      files: {
        "/w/scope.sh": "#!/bin/sh\nV=child\nhelper() { true; }\ncd /\nprintf '%s' \"$V\"\n",
      },
      script: [
        "chmod 755 /w/scope.sh",
        "cd /w",
        "V=parent",
        "./scope.sh",
        'printf \'|%s|%s\' "$V" "$(pwd)"',
        "helper || printf '|no-helper'",
      ],
      stdout: "child|parent|/w|no-helper",
      stderrIncludes: "helper: command not found",
    },
    {
      name: "inherits the environment and the working directory",
      files: { "/w/inherit.sh": '#!/bin/sh\nprintf \'%s:%s\' "$SHARED" "$(pwd)"\n' },
      script: ["chmod 755 /w/inherit.sh", "cd /w", "SHARED=value", "./inherit.sh"],
      stdout: "value:/w",
    },
    {
      name: "bounds recursive execution",
      files: { "/w/loop.sh": "#!/bin/sh\n./loop.sh\n" },
      script: ["chmod 755 /w/loop.sh", "cd /w", "./loop.sh"],
      exitCode: 1,
      stderrIncludes: "shell script nesting limit exceeded",
    },
  ]);

  it("rejects a script that is not valid UTF-8 before running it", async () => {
    const harness = createBashHarness({ commandResolution: "path" });
    await harness.fileSystem.writeFile("/w/bytes.sh", new Uint8Array([0xff, 0xfe, 0x0a]), {
      createParents: true,
    });
    harness.fileSystem.setMetadata("/w/bytes.sh", { mode: EXECUTABLE });
    const result = await harness.run("/w/bytes.sh");
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("is not valid UTF-8");
  });

  it("does not search PATH for a name containing a separator", async () => {
    const harness = await withScripts(
      { "/opt/tools/nested/run.sh": "#!/bin/sh\nprintf nested\n" },
      ["/opt/tools/nested/run.sh"],
    );
    const result = await harness.run("PATH=/opt/tools nested/run.sh", { cwd: "/" });
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toBe("nested/run.sh: command not found\n");
  });

  it("finds a script through a PATH component that is not an applet directory", async () => {
    const harness = await withScripts({ "/opt/tools/greet": "#!/bin/sh\nprintf found\n" }, [
      "/opt/tools/greet",
    ]);
    const found = await harness.run("PATH=/opt/tools:/bin greet");
    expect(found.stdout).toBe("found");
    expect(found.exitCode).toBe(0);

    const missing = await harness.run("PATH=/bin greet");
    expect(missing.exitCode).toBe(127);
  });

  it("prefers an applet over a file of the same name in an applet directory", async () => {
    const harness = await withScripts({ "/bin/echo": "#!/bin/sh\nprintf shadowed\n" }, [
      "/bin/echo",
    ]);
    const result = await harness.run("PATH=/bin echo applet");
    expect(result.stdout).toBe("applet\n");
  });

  it("keeps a script inside the readable roots", async () => {
    const harness = await withScripts({ "/secret/run.sh": "#!/bin/sh\nprintf leak\n" }, [
      "/secret/run.sh",
    ]);
    const scoped = createBashHarness({
      fileSystem: harness.fileSystem,
      commandResolution: "path",
      policy: { readRoots: ["/w"] },
    });
    const result = await scoped.run("/secret/run.sh");
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("outside the readable roots");
  });

  it("authorizes script execution through the shell profile name", async () => {
    const harness = await withScripts({ "/w/ok.sh": "#!/bin/sh\nprintf ran\n" }, ["/w/ok.sh"]);
    const allowed = createBashHarness({
      fileSystem: harness.fileSystem,
      commandResolution: "path",
      policy: { allowedCommands: [SHELL_PROFILE_COMMAND, "printf"] },
    });
    expect((await allowed.run("/w/ok.sh")).stdout).toBe("ran");

    const denied = createBashHarness({
      fileSystem: harness.fileSystem,
      commandResolution: "path",
      policy: { allowedCommands: ["printf"] },
    });
    const result = await denied.run("/w/ok.sh");
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toBe("command is not allowed: /w/ok.sh\n");
  });
});

describe("the sh applet", () => {
  scriptCases([
    {
      name: "runs a command string",
      script: "sh -c 'printf hi'",
      stdout: "hi",
    },
    {
      name: "answers to bash and to an applet path",
      script: ["/bin/sh -c 'printf a'", "bash -c 'printf b'", "/usr/bin/bash -c 'printf c'"],
      stdout: "abc",
    },
    {
      name: "isolates the command string",
      script: ["sh -c 'V=inner'", "printf '%s' \"${V-unset}\""],
      stdout: "unset",
    },
    {
      name: "names positional parameters after the command",
      script: 'sh -c \'printf "%s:%s" "$0" "$1"\' label first',
      stdout: "label:first",
    },
    {
      name: "runs a file operand without requiring the executable bit",
      files: { "/w/lib.sh": "printf 'lib %s' \"$1\"\n" },
      script: "sh /w/lib.sh arg",
      stdout: "lib arg",
    },
    {
      name: "propagates the status of the unit",
      script: ["sh -c 'exit 5'", "printf 'st=%s' \"$?\""],
      stdout: "st=5",
    },
    {
      name: "rejects an unsupported option",
      script: "sh -x",
      exitCode: 2,
      stderrIncludes: "sh: unsupported option -x",
    },
    {
      name: "rejects reading a script from standard input",
      script: "sh",
      exitCode: 2,
      stderrIncludes: "reading a script from standard input is not supported",
    },
    {
      name: "requires a command after -c",
      script: "sh -c",
      exitCode: 2,
      stderrIncludes: "-c requires a command",
    },
  ]);
});

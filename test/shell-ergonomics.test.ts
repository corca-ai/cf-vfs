import { describe, expect, it } from "vitest";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { bashCases, createBashHarness } from "./helpers/bash.js";

const HOME = { HOME: "/home/cf" };

describe("tilde expansion", () => {
  bashCases([
    {
      name: "expands a bare tilde to HOME",
      script: "printf %s ~",
      env: HOME,
      stdout: "/home/cf",
    },
    {
      name: "expands a tilde prefix",
      script: "printf %s ~/notes/today.txt",
      env: HOME,
      stdout: "/home/cf/notes/today.txt",
    },
    {
      name: "reads a file through a tilde path",
      files: { "/home/cf/note.txt": "body" },
      script: "cat ~/note.txt",
      env: HOME,
      stdout: "body",
    },
    {
      name: "leaves a quoted tilde literal",
      script: "printf '%s|%s|%s' '~' \"~\" \\~",
      env: HOME,
      stdout: "~|~|~",
    },
    {
      name: "leaves a named-user form literal",
      script: "printf '%s|%s' ~alice ~alice/notes",
      env: HOME,
      stdout: "~alice|~alice/notes",
    },
    {
      name: "leaves the directory-stack forms literal",
      script: "printf '%s|%s|%s' ~+ ~- ~2",
      env: HOME,
      stdout: "~+|~-|~2",
    },
    {
      name: "leaves a tilde that is not at the start literal",
      script: "printf '%s|%s' a~ /x/~/y",
      env: HOME,
      stdout: "a~|/x/~/y",
    },
    {
      name: "leaves a tilde literal when HOME is unset",
      script: ["unset HOME", "printf '%s|%s' ~ ~/notes"],
      env: HOME,
      stdout: "~|~/notes",
    },
    {
      name: "leaves a tilde literal when HOME is empty",
      script: "printf %s ~",
      env: { HOME: "" },
      stdout: "~",
    },
    {
      name: "does not expand a tilde produced by an expansion",
      script: ["VALUE='~/notes'", 'printf %s "$VALUE"'],
      env: HOME,
      stdout: "~/notes",
    },
    {
      name: "expands a tilde after = and after each colon in an assignment",
      script: ["TOOLS=~/bin:~/tools", 'printf %s "$TOOLS"'],
      env: HOME,
      stdout: "/home/cf/bin:/home/cf/tools",
    },
    {
      name: "leaves a quoted assignment value literal",
      script: ["TOOLS='~/bin'", 'printf %s "$TOOLS"'],
      env: HOME,
      stdout: "~/bin",
    },
  ]);

  it("charges tilde output to the expansion budget", async () => {
    const harness = createBashHarness({ limits: { maxExpansionChars: 32 } });
    const result = await harness.run("printf %s ~/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
      env: { HOME: "/home/cf" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("expansion");
  });
});

describe("working-directory tracking", () => {
  bashCases([
    {
      name: "records the previous directory in OLDPWD",
      files: { "/a/keep": "x", "/b/keep": "x" },
      script: ["cd /a", "cd /b", 'printf \'%s|%s\' "$PWD" "$OLDPWD"'],
      stdout: "/b|/a",
    },
    {
      name: "swaps with cd - and reports the new directory",
      files: { "/a/keep": "x", "/b/keep": "x" },
      script: ["cd /a", "cd /b", "cd -", 'printf \'|%s|%s\' "$PWD" "$OLDPWD"'],
      stdout: "/a\n|/a|/b",
    },
    {
      name: "refuses cd - with no previous directory",
      script: "cd -",
      exitCode: 2,
      stderrIncludes: "cd: OLDPWD not set",
    },
    {
      name: "changes to HOME with no operand",
      files: { "/home/cf/keep": "x" },
      script: ["cd", "pwd"],
      env: HOME,
      stdout: "/home/cf\n",
    },
    {
      name: "refuses a bare cd when HOME is unset",
      script: "cd",
      exitCode: 2,
      stderrIncludes: "cd: HOME not set",
    },
    {
      name: "keeps a subshell directory change inside the subshell",
      files: { "/a/keep": "x", "/b/keep": "x" },
      script: ["cd /a", "(cd /b; printf '%s|' \"$PWD\")", 'printf \'%s|%s\' "$PWD" "$OLDPWD"'],
      // The first `cd /a` set OLDPWD to the initial directory, and the
      // subshell's own change is discarded with its clone.
      stdout: "/b|/a|/",
    },
    {
      name: "keeps a script directory change inside the script",
      files: { "/a/keep": "x", "/b/keep": "x", "/a/move.sh": "#!/bin/sh\ncd /b\n" },
      script: ["chmod 755 /a/move.sh", "cd /a", "/a/move.sh", "printf '%s' \"$PWD\""],
      stdout: "/a",
    },
    {
      name: "lets a function change the caller's directory",
      files: { "/a/keep": "x", "/b/keep": "x" },
      script: ["cd /a", "enter() { cd /b; }", "enter", 'printf \'%s|%s\' "$PWD" "$OLDPWD"'],
      stdout: "/b|/a",
    },
  ]);
});

describe("shell option state", () => {
  bashCases([
    {
      name: "accepts a combined short cluster",
      script: ["set -eu", 'printf %s "$-"'],
      stdout: "eu",
    },
    {
      name: "clears a combined short cluster",
      script: ["set -eu", "set +eu", 'printf "[%s]" "$-"'],
      stdout: "[]",
    },
    {
      name: "reports an option set through its long name",
      script: ["set -o errexit", 'printf %s "$-"'],
      stdout: "e",
    },
    {
      name: "omits pipefail, which has no short flag",
      script: ["set -o pipefail", 'printf "[%s]" "$-"'],
      stdout: "[]",
    },
    {
      name: "accepts several words in one invocation",
      script: ["set -e -o nounset", 'printf %s "$-"'],
      stdout: "eu",
    },
    {
      name: "rejects an unsupported short flag inside a cluster",
      script: "set -ex",
      exitCode: 2,
      stderrIncludes: "set: unsupported option -x",
    },
    {
      name: "rejects an unsupported option name",
      script: "set -o noclobber",
      exitCode: 2,
      stderrIncludes: "set: unsupported option name: noclobber",
    },
    {
      name: "reports no options when none are set",
      script: 'printf "[%s]" "$-"',
      stdout: "[]",
    },
    {
      name: "keeps option state out of a subshell's caller",
      script: ["(set -e; printf '%s|' \"$-\")", 'printf "[%s]" "$-"'],
      stdout: "e|[]",
    },
  ]);
});

describe("permission-shaped predicates", () => {
  bashCases([
    {
      name: "reads the mode bits of a file",
      files: { "/f": "body" },
      script: [
        "chmod 400 /f",
        "test -r /f && printf r",
        "test -w /f || printf ' no-w'",
        "test -x /f || printf ' no-x'",
      ],
      stdout: "r no-w no-x",
    },
    {
      name: "sees an executable bit in any class",
      files: { "/f": "body" },
      script: ["chmod 001 /f", "test -x /f && printf x"],
      stdout: "x",
    },
    {
      name: "reports nothing for a missing path",
      script: "test -r /absent || test -w /absent || test -x /absent || printf none",
      stdout: "none",
    },
    {
      name: "reports a directory as searchable when its bits say so",
      files: { "/d/keep": "x" },
      script: ["test -x /d && printf x", "chmod 600 /d", "test -x /d || printf ' no-x'"],
      stdout: "x no-x",
    },
    {
      name: "is unaffected by the write roots",
      files: { "/f": "body" },
      script: ["chmod 644 /f", "test -w /f && printf w"],
      stdout: "w",
    },
  ]);

  it("does not consult the policy write roots", async () => {
    const harness = createBashHarness({ policy: { writeRoots: ["/allowed"] } });
    await harness.fileSystem.writeFile("/elsewhere", "body");
    harness.fileSystem.setMetadata("/elsewhere", { mode: 0o100644 });
    // The predicate answers about metadata; the policy still refuses the write.
    const predicate = await harness.run("test -w /elsewhere && printf metadata-says-writable");
    expect(predicate.stdout).toBe("metadata-says-writable");
    const write = await harness.run("printf x > /elsewhere");
    expect(write.exitCode).toBe(126);
  });
});

describe("help", () => {
  it("lists every registered command with its summary", async () => {
    const harness = createBashHarness();
    const result = await harness.run("help");
    expect(result.exitCode).toBe(0);
    const listed = result.stdout.trimEnd().split("\n");
    expect(listed).toHaveLength(defaultShellCommands.length + 1);
    expect(result.stdout).toContain("cd          changes the working directory");
  });

  it("describes a named command and its synopsis", async () => {
    const harness = createBashHarness();
    const described = await harness.run("help cd");
    expect(described.stdout).toBe("cd [DIRECTORY|-]\n    changes the working directory\n");
    const synopsis = await harness.run("help -s cd");
    expect(synopsis.stdout).toBe("cd [DIRECTORY|-]\n");
  });

  it("reports an unknown topic with status 1", async () => {
    const harness = createBashHarness();
    const result = await harness.run("help cd nonexistent");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("cd [DIRECTORY|-]\n    changes the working directory\n");
    expect(result.stderr).toBe("help: no help topics match `nonexistent'\n");
  });

  it("describes only what the active registry registered", async () => {
    const [first] = defaultShellCommands;
    const harness = createBashHarness({
      commands: defaultShellCommands.filter(
        (command) => command.name === "help" || command === first,
      ),
    });
    const result = await harness.run("help");
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(2);
  });
});

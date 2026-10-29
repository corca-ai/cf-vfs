import { describe } from "vitest";
import { awkCommand } from "../src/shell/commands/awk.js";
import { bashCases } from "./helpers/bash.js";

// grep, cat and awk features agents reached for while auditing a wiki, each
// pinned to what GNU grep, coreutils and gawk print.

const PAGES = {
  "/t/a.md": "1\n2 hit\n3\n4\n5\n6\n7 hit\n8\n",
  "/t/b.txt": "hit\n",
  "/t/skip/c.md": "hit\n",
  "/p": "hit\n3\n",
};

describe("grep context, selection and walk filters", () => {
  bashCases([
    {
      name: "prints context with -C and separates groups",
      files: PAGES,
      script: "grep -n -C1 hit /t/a.md",
      stdout: "1-1\n2:2 hit\n3-3\n--\n6-6\n7:7 hit\n8-8\n",
    },
    {
      name: "names context lines with - and separates files",
      files: PAGES,
      script: "grep -A1 hit /t/a.md /t/b.txt",
      stdout: "/t/a.md:2 hit\n/t/a.md-3\n--\n/t/a.md:7 hit\n/t/a.md-8\n--\n/t/b.txt:hit\n",
    },
    {
      name: "stops after -m matches and keeps leading context",
      files: PAGES,
      script: "grep -B2 -m1 hit /t/a.md; grep -c -m2 hit /t/a.md",
      stdout: "1\n2 hit\n2\n",
    },
    {
      name: "filters a walk with --include, --exclude and --exclude-dir",
      files: PAGES,
      script:
        "cd /t; grep -rl hit --include='*.md' .; grep -rl hit --exclude-dir=skip .; grep -rl --exclude='*.md' hit .",
      stdout: "./a.md\n./skip/c.md\n./a.md\n./b.txt\n./b.txt\n",
    },
    {
      name: "takes several patterns from -e and -f",
      files: PAGES,
      script: "grep -e 3 -e 5 /t/a.md; grep -c -f /p /t/a.md",
      stdout: "3\n5\n3\n",
    },
    {
      name: "matches whole words with -w",
      script:
        "printf 'cat\\nconcat\\ncat dog\\n' | grep -w cat; printf 'a b\\n' | grep -ow 'a\\|b'",
      stdout: "cat\ncat dog\na\nb\n",
    },
    {
      name: "names the file with -H and silences errors with -s",
      files: PAGES,
      script: "grep -H hit /t/b.txt; grep -s hit /nope; echo $?",
      stdout: "/t/b.txt:hit\n2\n",
    },
    {
      name: "reports an unreadable operand and keeps searching",
      files: PAGES,
      script: "grep hit /nope /t/b.txt; echo $?",
      stdout: "/t/b.txt:hit\n2\n",
      stderrIncludes: "grep: /nope:",
    },
  ]);
});

describe("cat display options", () => {
  const files = { "/f": "a\tb\n\n\n\nc\x01\n" };
  bashCases([
    {
      name: "numbers every line",
      files,
      script: "cat -n /f",
      stdout: "     1\ta\tb\n     2\t\n     3\t\n     4\t\n     5\tc\x01\n",
    },
    {
      name: "numbers non-blank lines",
      files,
      script: "cat -b /f",
      stdout: "     1\ta\tb\n\n\n\n     2\tc\x01\n",
    },
    { name: "squeezes blank lines", files, script: "cat -s /f", stdout: "a\tb\n\nc\x01\n" },
    {
      name: "shows everything with -A",
      files,
      script: "cat -A /f",
      stdout: "a^Ib$\n$\n$\n$\nc^A$\n",
    },
    {
      name: "numbers across operands as one stream",
      files,
      script: "printf 'x\\n' | cat -n - /f | head -2",
      stdout: "     1\tx\n     2\ta\tb\n",
    },
  ]);
});

describe("awk functions and output redirection", () => {
  bashCases(
    [
      {
        name: "calls a user function defined before or after its use",
        script: `awk 'function add(a, b) { return a + b } BEGIN { print add(2, 3), fact(5) } function fact(n) { return n <= 1 ? 1 : n * fact(n - 1) }'`,
        stdout: "5 120\n",
      },
      {
        name: "passes arrays by reference and keeps extra parameters local",
        script: `awk 'function fill(arr, n,   i) { for (i = 1; i <= n; i++) arr[i] = i * i } BEGIN { fill(sq, 3); print sq[1], sq[2], sq[3], "[" i "]" }'`,
        stdout: "1 4 9 []\n",
      },
      {
        name: "prints from a function in order",
        script: `printf 'a\\nb\\n' | awk 'function say(x) { print "say", x } { say($1); print "after" }'`,
        stdout: "say a\nafter\nsay b\nafter\n",
      },
      {
        name: "ends the program from a function with exit",
        script: `awk 'function f() { exit 3 } BEGIN { f(); print "no" }'; echo $?`,
        stdout: "3\n",
      },
      {
        name: "redirects to files, appends with >>, and reopens after close",
        script: `echo x > /log; printf 'a 1\\nb 2\\na 3\\n' | awk '{ print $2 > ("/out-" $1) } END { print "y" >> "/log"; close("/out-b"); print "again" > "/out-b" }'; cat /out-a /out-b /log`,
        stdout: "1\n3\nagain\nx\ny\n",
      },
      {
        name: "writes to standard error",
        script: `awk 'BEGIN { print "err" > "/dev/stderr"; print "out" }'`,
        stdout: "out\n",
        stderr: "err\n",
      },
      {
        name: "bounds recursion by the function depth",
        script: `awk 'function r(n) { return r(n + 1) } BEGIN { r(1) }'`,
        exitCode: 1,
        stderrIncludes: "function call depth limit exceeded",
      },
    ],
    { extraCommands: [awkCommand] },
  );
});

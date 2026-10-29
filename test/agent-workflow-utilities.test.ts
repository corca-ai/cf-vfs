import { describe, expect, it } from "vitest";
import { bashCases, createBashHarness } from "./helpers/bash.js";

// Behaviors an agent reached for while maintaining a Markdown wiki, each
// pinned to what GNU coreutils, diffutils and grep do.

describe("cp into existing directories", () => {
  bashCases([
    {
      name: "copies a directory's contents with a trailing /.",
      files: { "/src/a": "a\n", "/src/sub/b": "b\n" },
      script: "mkdir /dst && cp -r /src/. /dst/ && find /dst | sort",
      stdout: "/dst\n/dst/a\n/dst/sub\n/dst/sub/b\n",
    },
    {
      name: "copies . from the working directory",
      files: { "/q/r/z": "z\n" },
      script: "mkdir /t && cd /q && cp -r . ../t && find /t | sort",
      stdout: "/t\n/t/r\n/t/r/z\n",
    },
    {
      name: "creates a missing destination from a contents operand",
      files: { "/src/sub/b": "b\n" },
      script: "cp -r /src/. /new && find /new | sort",
      stdout: "/new\n/new/sub\n/new/sub/b\n",
    },
    {
      name: "merges into a destination subdirectory that already exists",
      files: { "/s/x/f": "1\n", "/d/s/y/g": "2\n" },
      script: "cp -r /s /d && find /d | sort",
      stdout: "/d\n/d/s\n/d/s/x\n/d/s/x/f\n/d/s/y\n/d/s/y/g\n",
    },
    {
      name: "refuses to merge a directory into itself",
      files: { "/a/b/f": "f\n" },
      script: "cp -r /a/. /a/b",
      exitCode: 2,
      stderrIncludes: "cannot copy a directory into itself",
    },
  ]);
});

describe("tr", () => {
  bashCases([
    {
      name: "translates escaped newlines and tabs",
      script: "printf 'a b, c\\td\\n' | tr ', \\t' '\\n\\n_'",
      stdout: "a\nb\n\nc_d\n",
    },
    {
      name: "reads octal escapes",
      script: "printf 'a-b\\n' | tr '\\055' '+'",
      stdout: "a+b\n",
    },
    {
      name: "expands several ranges in one set",
      script: "printf 'Hello World\\n' | tr 'a-zA-Z' 'n-za-mN-ZA-M'",
      stdout: "Uryyb Jbeyq\n",
    },
    {
      name: "pairs upper and lower classes",
      script: "printf 'Hello World\\n' | tr '[:upper:]' '[:lower:]'",
      stdout: "hello world\n",
    },
    {
      name: "pads a short SET2 with its last character",
      script: "printf 'abc\\n' | tr abc xy",
      stdout: "xyy\n",
    },
    { name: "deletes with -d", script: "printf 'x\\r\\ny\\r\\n' | tr -d '\\r'", stdout: "x\ny\n" },
    { name: "squeezes with -s", script: "printf 'a  b   c\\n' | tr -s ' '", stdout: "a b c\n" },
    {
      name: "squeezes the translated set with two operands",
      script: "printf 'aabbcc\\n' | tr -s 'a-c' 'x'",
      stdout: "x\n",
    },
    {
      name: "deletes the complement with -cd",
      script: "printf 'a1b2c3\\n' | tr -cd '0-9\\n'",
      stdout: "123\n",
    },
    {
      name: "translates the complement",
      script: "printf 'hello, world!\\n' | tr -c 'a-z\\n' '_'",
      stdout: "hello__world_\n",
    },
    {
      name: "deletes and then squeezes with -ds",
      script: "printf 'aaa bbb\\n' | tr -ds 'b' 'a'",
      stdout: "a \n",
    },
    {
      name: "names a set that looks like an option after the first set",
      script: "printf 'a-b\\n' | tr - _",
      stdout: "a_b\n",
    },
    {
      name: "refuses a reversed range",
      script: "printf 'a\\n' | tr z-a q",
      exitCode: 2,
      stderrIncludes: "reverse order",
    },
    {
      name: "refuses an unknown class",
      script: "printf 'a\\n' | tr '[:nope:]' q",
      exitCode: 2,
      stderrIncludes: "invalid character class",
    },
  ]);
});

describe("cmp", () => {
  bashCases([
    {
      name: "reports only by status with -s",
      files: { "/p": "x\n", "/q": "x\n", "/r": "y\n" },
      script: "cmp -s /p /q; echo $?; cmp -s /p /r; echo $?",
      stdout: "0\n1\n",
    },
    {
      name: "names the differing byte and line",
      files: { "/p": "a\nbc\n", "/q": "a\nbd\n" },
      script: "cmp /p /q",
      exitCode: 1,
      stdout: "/p /q differ: byte 4, line 2\n",
    },
    {
      name: "reports end of file after a complete line",
      files: { "/p": "a\n", "/q": "a\nb" },
      script: "cmp /p /q",
      exitCode: 1,
      stderr: "cmp: EOF on /p after byte 2, line 1\n",
    },
    {
      name: "reports end of file inside a line",
      files: { "/p": "a\nbc", "/q": "a\nbcd" },
      script: "cmp /p /q",
      exitCode: 1,
      stderr: "cmp: EOF on /p after byte 4, in line 2\n",
    },
    {
      name: "reports an empty file",
      files: { "/p": "", "/q": "a\n" },
      script: "cmp /p /q",
      exitCode: 1,
      stderr: "cmp: EOF on /p which is empty\n",
    },
  ]);
});

describe("diff on directories", () => {
  bashCases([
    {
      name: "compares trees recursively with -r",
      files: {
        "/d1/f": "a\n",
        "/d2/f": "b\n",
        "/d1/s/g": "same\n",
        "/d2/s/g": "diff\n",
        "/d2/new": "x\n",
        "/d1/only/h": "h\n",
        "/d1/k/i": "i\n",
        "/d2/k": "",
      },
      script: "diff -r /d1 /d2",
      exitCode: 1,
      stdout: [
        "diff -r /d1/f /d2/f",
        "--- /d1/f",
        "+++ /d2/f",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "File /d1/k is a directory while file /d2/k is a regular empty file",
        "Only in /d2: new",
        "Only in /d1: only",
        "diff -r /d1/s/g /d2/s/g",
        "--- /d1/s/g",
        "+++ /d2/s/g",
        "@@ -1 +1 @@",
        "-same",
        "+diff",
        "",
      ].join("\n"),
    },
    {
      name: "reports identical trees by status",
      files: { "/e1/f": "a\n", "/e2/f": "a\n", "/e1/s/g": "g\n", "/e2/s/g": "g\n" },
      script: "diff -r /e1 /e2; echo $?",
      stdout: "0\n",
    },
    {
      name: "names common subdirectories without -r",
      files: { "/e1/f": "a\n", "/e2/f": "a\n", "/e1/s/g": "g\n", "/e2/s/h": "h\n" },
      script: "diff /e1 /e2",
      stdout: "Common subdirectories: /e1/s and /e2/s\n",
    },
    {
      name: "summarizes with -q and trims trailing slashes",
      files: { "/e1/f": "a\n", "/e2/f": "b\n", "/e2/z": "z\n" },
      script: "diff -rq /e1/ /e2/",
      exitCode: 1,
      stdout: "Files /e1/f and /e2/f differ\nOnly in /e2/: z\n",
    },
    {
      name: "compares a file with its namesake inside a directory",
      files: { "/f": "a\n", "/d/f": "a\n" },
      script: "diff /f /d; echo $?",
      stdout: "0\n",
    },
  ]);
});

describe("grep line and file selection", () => {
  bashCases([
    {
      name: "selects whole lines with -x",
      script: "printf 'ab\\nabc\\nb\\n' | grep -x ab",
      stdout: "ab\n",
    },
    {
      name: "applies -x to every branch of an alternation",
      script:
        "printf 'ab\\nabc\\nb\\n' | grep -x 'a\\|b'; printf 'ab\\nabc\\n' | grep -xE 'ab|abc'",
      stdout: "b\nab\nabc\n",
    },
    {
      name: "keeps explicit anchors meaningful under -x",
      script: "printf '^a\\na\\nab\\n' | grep -x '^a'; printf 'a$\\na\\n' | grep -x 'a\\$'",
      stdout: "a\na$\n",
    },
    {
      name: "compares whole lines with -xF",
      script: "printf 'AB\\nABC\\n' | grep -xiF ab",
      stdout: "AB\n",
    },
    {
      name: "lists files without a match with -L",
      files: { "/g1": "x\n", "/g2": "y\n", "/gd/a/1": "x\n", "/gd/2": "y\n" },
      script: "grep -L x /g1 /g2; echo $?; grep -L z /g1 /g2; echo $?; grep -rL x /gd",
      stdout: "/g2\n0\n/g1\n/g2\n1\n/gd/2\n",
    },
  ]);
});

it("bounds expansion per result, so ordinary nested loops finish", async () => {
  // Twenty files of five links, each checked against a thirty-name list: about
  // twenty thousand fields in total, but never more than a few at once.
  const harness = createBashHarness();
  const names = Array.from({ length: 30 }, (_, index) => `page-${index}`);
  const pages = names.slice(0, 20);
  await harness.fileSystem.writeFile("/names.txt", `${names.join("\n")}\n`, {
    createParents: true,
  });
  for (const name of pages) {
    await harness.fileSystem.writeFile(
      `/wiki/${name}.md`,
      "[[page-1]] [[page-2]] [[missing]] [[page-3]] [[page-4]]\n",
      { createParents: true },
    );
  }
  const result = await harness.run(`
cd /wiki
for f in $(find . -type f -name '*.md' | sort); do
  grep -o '\\[\\[[^]]*\\]\\]' "$f" | sed 's/^\\[\\[//; s/\\]\\]$//' | while read -r t; do
    found=0; while read -r n; do [ "$n" = "$t" ] && found=1; done < /names.txt
    [ $found = 0 ] && echo "$f: $t"
  done
done | sort -u | wc -l`);
  expect(result).toMatchObject({ exitCode: 0, stdout: "20\n", stderr: "" });
});

const SITE = {
  "/s/.git/config": "x",
  "/s/README.md": "hi",
  "/s/a/b.md": "hi there",
  "/s/a/c.txt": "",
  "/s/d/e.md": "no",
};

describe("find expressions", () => {
  bashCases([
    {
      name: "negates a path test",
      files: SITE,
      script: "cd /s && find . -not -path './.git/*' -type f | sort",
      stdout: "./README.md\n./a/b.md\n./a/c.txt\n./d/e.md\n",
    },
    {
      name: "prunes a directory and prints the rest",
      files: SITE,
      script: "cd /s && find . -path ./.git -prune -o -type f -print | sort",
      stdout: "./README.md\n./a/b.md\n./a/c.txt\n./d/e.md\n",
    },
    {
      name: "groups alternatives and negates with !",
      files: SITE,
      script:
        "cd /s && find . \\( -name '*.md' -o -name '*.txt' \\) -type f | sort; find . ! -name '*.md' -type f | sort",
      stdout: "./README.md\n./a/b.md\n./a/c.txt\n./d/e.md\n./.git/config\n./a/c.txt\n",
    },
    {
      name: "bounds depth from both ends",
      files: SITE,
      script: "cd /s && find . -mindepth 1 -maxdepth 1 | sort",
      stdout: "./.git\n./README.md\n./a\n./d\n",
    },
    {
      name: "matches case-insensitively, empty entries, and type lists",
      files: SITE,
      script:
        "mkdir /s/none && cd /s && find . -iname 'readme*'; find . -empty | sort; find . -type f,d -name a",
      stdout: "./README.md\n./a/c.txt\n./none\n./a\n",
    },
    {
      name: "matches the starting point's own name",
      files: SITE,
      script: "cd /s && find . -maxdepth 1 -name '.*' | sort",
      stdout: ".\n./.git\n",
    },
    {
      name: "batches -exec + after a test",
      files: SITE,
      script: "cd /s && find . -name '*.md' -exec grep -l hi {} +",
      stdout: "./README.md\n./a/b.md\n",
    },
    {
      name: "refuses an expression that ends at an operator",
      files: SITE,
      script: "find /s -name x -o",
      exitCode: 2,
      stderrIncludes: "expected an expression",
    },
  ]);
});

describe("reserved words as arguments", () => {
  bashCases([
    { name: "negates a test operand", script: "[ ! -e /missing ] && echo none", stdout: "none\n" },
    { name: "passes braces and ! as words", script: "echo a } { ! b", stdout: "a } { ! b\n" },
    { name: "keeps ! a pipeline prefix", script: "! false && echo negated", stdout: "negated\n" },
    { name: "keeps a brace group", script: "{ echo in; } && echo out", stdout: "in\nout\n" },
  ]);
});

describe("ls listings", () => {
  const files = {
    "/l/a.txt": "hello\n",
    "/l/big": "x".repeat(5000),
    "/l/.hid/f": "",
    "/l/sub/g": "",
  };

  bashCases([
    {
      name: "hides dot entries unless asked",
      files,
      script: "cd /l && ls; echo -; ls -A",
      stdout: "a.txt\nbig\nsub\n-\n.hid\na.txt\nbig\nsub\n",
    },
    {
      name: "sorts file operands before directories",
      files,
      script: "cd /l && ls sub big a.txt",
      stdout: "a.txt\nbig\n\nsub:\ng\n",
    },
  ]);

  it("prints GNU long rows with a total, link counts, times and aligned columns", async () => {
    const harness = createBashHarness();
    for (const [path, body] of Object.entries(files)) {
      await harness.fileSystem.writeFile(path, body, { createParents: true });
    }
    harness.fileSystem.setMetadata("/l/a.txt", { modifiedAtMs: Date.UTC(2024, 0, 2, 3, 4) });
    const result = await harness.run("cd /l && ls -la; ls -lh big a.txt");
    expect(result.stderr).toBe("");
    expect(
      result.stdout
        .split("\n")
        .map((line) => line.replace(/ [A-Z][a-z]{2} [ \d]\d \d\d:\d\d /u, " RECENT ")),
    ).toEqual([
      "total 6",
      "drwxr-xr-x 4 0 0    0 RECENT .",
      "drwxr-xr-x 3 0 0    0 RECENT ..",
      "drwxr-xr-x 2 0 0    0 RECENT .hid",
      "-rw-r--r-- 1 0 0    6 Jan  2  2024 a.txt",
      "-rw-r--r-- 1 0 0 5000 RECENT big",
      "drwxr-xr-x 2 0 0    0 RECENT sub",
      "-rw-r--r-- 1 0 0    6 Jan  2  2024 a.txt",
      "-rw-r--r-- 1 0 0 4.9K RECENT big",
      "",
    ]);
  });
});

it("reports a missing ls operand and still lists the rest", async () => {
  const harness = createBashHarness();
  await harness.fileSystem.writeFile("/m/a.txt", "a", { createParents: true });
  await expect(harness.run("cd /m && ls nope a.txt .")).resolves.toEqual({
    exitCode: 2,
    stdout: "a.txt\n\n.:\na.txt\n",
    stderr: "ls: cannot access 'nope': No such file or directory\n",
  });
});

describe("sort keys", () => {
  const files = {
    "/p": "b:3:x\na:10:y\nc:2:z\na:2:w\n",
    "/w": "  apple 3\nbanana 10\n cherry 2\nApple 3\n",
  };
  bashCases([
    {
      name: "sorts one numeric field",
      files,
      script: "sort -t: -k2,2n /p",
      stdout: "a:2:w\nc:2:z\nb:3:x\na:10:y\n",
    },
    {
      name: "combines keys with their own options",
      files,
      script: "sort -t: -k1,1 -k2,2nr /p",
      stdout: "a:10:y\na:2:w\nb:3:x\nc:2:z\n",
    },
    {
      name: "keeps leading blanks in a default field",
      files,
      script: "sort -k1,1 /w",
      stdout: "  apple 3\n cherry 2\nApple 3\nbanana 10\n",
    },
    {
      name: "skips leading blanks with -b",
      files,
      script: "sort -b -k1,1 /w",
      stdout: "Apple 3\n  apple 3\nbanana 10\n cherry 2\n",
    },
    {
      name: "inherits global options for a bare key",
      files,
      script: "sort -n -k2 /w",
      stdout: " cherry 2\n  apple 3\nApple 3\nbanana 10\n",
    },
    {
      name: "keeps the first line of each key with -u",
      files,
      script: "sort -t: -u -k1,1 /p",
      stdout: "a:10:y\nb:3:x\nc:2:z\n",
    },
    {
      name: "reverses the last-resort comparison",
      script: "printf '10 a\\n9 b\\n10 c\\n' | sort -rn",
      stdout: "10 c\n10 a\n9 b\n",
    },
    {
      name: "folds case with -f",
      files,
      script: "sort -bf -k1,1 /w | head -2",
      stdout: "  apple 3\nApple 3\n",
    },
    {
      name: "refuses a zero field",
      files,
      script: "sort -k0 /p",
      exitCode: 2,
      stderrIncludes: "invalid key position 0",
    },
  ]);
});

it("allows twenty thousand commands in one execution", async () => {
  const harness = createBashHarness();
  await expect(
    harness.run("i=0; while [ $i -lt 9000 ]; do i=$((i+1)); done; echo $i"),
  ).resolves.toMatchObject({
    exitCode: 0,
    stdout: "9000\n",
  });
  await expect(
    harness.run("i=0; while [ $i -lt 11000 ]; do i=$((i+1)); done"),
  ).resolves.toMatchObject({
    exitCode: 1,
    stderr: "shell command limit exceeded\n",
  });
});

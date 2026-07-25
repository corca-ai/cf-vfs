import { describe, expect, it } from "vitest";
import { compilePosixRegex } from "../src/core/posix-regex.js";
import { bashCases, createBashHarness } from "./helpers/bash.js";

const TREE = {
  "/t/a.txt": "alpha\nbeta\n",
  "/t/sub/b.txt": "gamma\nalpha\n",
  "/t/c.log": "nothing\n",
};

describe("POSIX regular-expression matching", () => {
  const matches = (
    pattern: string,
    dialect: "basic" | "extended",
    subject: string,
    options: { ignoreCase?: boolean } = {},
  ): boolean => compilePosixRegex(pattern, dialect, "grep", options).test(subject);

  it("gives each dialect its own metacharacters", () => {
    // Bare `+` repeats in an extended expression and is a literal in a basic
    // one; a backslash swaps which is which.
    expect(matches("a+", "extended", "aa")).toBe(true);
    expect(matches("a+", "basic", "a+")).toBe(true);
    expect(matches("a+", "basic", "aa")).toBe(false);
    expect(matches("a\\+", "basic", "aa")).toBe(true);
    expect(matches("a\\|b", "basic", "b")).toBe(true);
    expect(matches("a|b", "extended", "b")).toBe(true);
    expect(matches("a|b", "basic", "a|b")).toBe(true);
  });

  it("anchors only where POSIX does", () => {
    expect(matches("^a$", "basic", "a")).toBe(true);
    expect(matches("^a$", "basic", "ba")).toBe(false);
    // A caret in the middle is a literal in a basic expression.
    expect(matches("a^b", "basic", "a^b")).toBe(true);
    expect(matches("a$b", "basic", "a$b")).toBe(true);
  });

  it("expands POSIX character classes in the C locale", () => {
    expect(matches("[[:digit:]]", "basic", "5")).toBe(true);
    expect(matches("[[:digit:]]", "basic", "x")).toBe(false);
    expect(matches("[[:alpha:][:digit:]]", "basic", "7")).toBe(true);
    expect(matches("[^[:digit:]]", "basic", "x")).toBe(true);
    expect(matches("[a-c]", "basic", "b")).toBe(true);
    expect(matches("[a-c]", "basic", "d")).toBe(false);
    // A leading `]` is a literal, as POSIX has it.
    expect(matches("[]a]", "basic", "]")).toBe(true);
  });

  it("folds case for ASCII only, everywhere a letter can appear", () => {
    const fold = { ignoreCase: true };
    expect(matches("k", "basic", "K", fold)).toBe(true);
    // The Kelvin sign and the long s fold onto k and s in Unicode. The runtime
    // declares the C locale, so they must not match here.
    expect(matches("k", "basic", "\u212a", fold)).toBe(false);
    expect(matches("s", "basic", "\u017f", fold)).toBe(false);
    // A bracket folds each member, not just a lowercase range.
    expect(matches("[a-c]", "basic", "B", fold)).toBe(true);
    expect(matches("[abc]", "basic", "A", fold)).toBe(true);
    expect(matches("[ABC]", "basic", "c", fold)).toBe(true);
    expect(matches("[A-F]", "basic", "d", fold)).toBe(true);
    expect(matches("[abc]", "basic", "D", fold)).toBe(false);
    // A trailing literal `-` must survive folding rather than become a range.
    expect(matches("[a-z0-9_-]", "basic", "-", fold)).toBe(true);
    expect(matches("[a-z0-9_-]", "basic", "Q", fold)).toBe(true);
    // A negated set folds its members before the negation applies.
    expect(matches("[^a-c]", "basic", "B", fold)).toBe(false);
  });

  it("refuses every construct outside the declared subset", () => {
    for (const pattern of ["\\d", "\\w", "\\s", "\\b", "\\<", "\\1", "\\A"]) {
      expect(() => compilePosixRegex(pattern, "extended", "grep"), pattern).toThrowError(/grep:/u);
    }
    for (const malformed of ["[abc", "\\", "(a", "a)", "a{", "[[:nope:]]", "[]"]) {
      expect(() => compilePosixRegex(malformed, "extended", "grep"), malformed).toThrowError(
        /grep:/u,
      );
    }
    // An equivalence class or collating symbol has no meaning without a locale
    // table, and matching its punctuation literally would be a wrong answer
    // rather than a refusal.
    for (const bracket of ["[[=a=]]", "[[.a.]]"]) {
      expect(() => compilePosixRegex(bracket, "basic", "grep"), bracket).toThrowError(/grep:/u);
    }
  });

  it("treats a leading repetition operator as a literal, as POSIX does", () => {
    expect(matches("*ab", "basic", "*ab")).toBe(true);
    expect(matches("*ab", "extended", "*ab")).toBe(true);
    // A `*` after an anchor is a literal asterisk, as GNU has it.
    expect(matches("^*x", "basic", "*x")).toBe(true);
  });

  it("accepts a stacked repetition rather than inventing a literal", () => {
    // GNU reads `a**` as `a*`. Treating the second star as a literal would
    // silently match different text.
    expect(matches("a**", "extended", "aaa")).toBe(true);
    expect(matches("a**b", "extended", "b")).toBe(true);
    expect(matches("a\\{2\\}*", "basic", "aaaa")).toBe(true);
  });

  it("keeps a JavaScript group construct from meaning anything", () => {
    // `(?:a)` is a non-capturing group in JavaScript. Here `?` has nothing to
    // repeat, so it is one more literal and the group still captures.
    expect(matches("(?:a)", "basic", "(?:a)")).toBe(true);
    expect(matches("(?:a)", "extended", "?:a")).toBe(true);
    expect(matches("(?:a)", "extended", "a")).toBe(false);
  });

  it("matches in time linear in the record, whatever the pattern", () => {
    // A backtracking engine takes exponential time on both of these. They are
    // short enough for any caller to type, and a synchronous match cannot be
    // interrupted by the deadline or the abort signal, so the bound has to come
    // from the matcher itself.
    const runs = [
      { pattern: "(a+)+$", subject: `${"a".repeat(2000)}!`, expected: false },
      // `(a|a)*` matches empty, so this one succeeds at the end of the record.
      { pattern: "(a|a)*$", subject: `${"a".repeat(2000)}!`, expected: true },
      { pattern: "a*a*a*a*a*a*a*a*b", subject: "a".repeat(2000), expected: false },
    ];
    for (const { pattern, subject, expected } of runs) {
      const compiled = compilePosixRegex(pattern, "extended", "grep");
      const started = performance.now();
      expect(compiled.test(subject), pattern).toBe(expected);
      expect(performance.now() - started, pattern).toBeLessThan(2000);
    }
  });

  it("reports the leftmost match with its groups", () => {
    const compiled = compilePosixRegex("\\(a*\\)b", "basic", "sed");
    expect(compiled.exec("xxaabyy")).toEqual({ index: 2, end: 5, groups: ["aab", "aa"] });
    expect(compiled.exec("xxaabyy", 5)).toBeUndefined();
    expect(compilePosixRegex("b", "basic", "sed").exec("aba", 2)).toBeUndefined();
  });
});

describe("grep profile", () => {
  bashCases([
    {
      name: "walks a subtree with -r and names each match by its operand",
      files: TREE,
      script: "grep -r alpha /t | sort",
      stdout: "/t/a.txt:alpha\n/t/sub/b.txt:alpha\n",
    },
    {
      name: "lists only matching files with -l",
      files: TREE,
      script: "grep -rl alpha /t | sort",
      stdout: "/t/a.txt\n/t/sub/b.txt\n",
    },
    {
      name: "reports a match with -q and produces nothing",
      files: TREE,
      script:
        "grep -q alpha /t/a.txt; printf '%s|' \"$?\"; grep -q zzz /t/a.txt; printf '%s' \"$?\"",
      stdout: "0|1",
    },
    {
      name: "counts per file under -r",
      files: TREE,
      script: "grep -rc alpha /t | sort",
      stdout: "/t/a.txt:1\n/t/c.log:0\n/t/sub/b.txt:1\n",
    },
    {
      name: "suppresses the name with -h",
      files: TREE,
      script: "grep -rh alpha /t | sort",
      stdout: "alpha\nalpha\n",
    },
    {
      name: "treats a bare plus as a literal in a basic expression",
      files: { "/in": "a+b\naab\n" },
      script: "grep 'a+' /in",
      stdout: "a+b\n",
    },
    {
      name: "repeats with a bare plus in an extended expression",
      files: { "/in": "a+b\naab\n" },
      script: "grep -E 'a+b' /in",
      stdout: "aab\n",
    },
    {
      name: "rejects both -F and -E together",
      script: "grep -FE x /dev-null-placeholder",
      exitCode: 2,
      stderrIncludes: "grep: specify at most one of -F and -E",
    },
    {
      name: "rejects a pattern outside the declared subset",
      files: { "/in": "a\n" },
      script: "grep '\\w' /in",
      exitCode: 2,
      stderrIncludes: "grep: unsupported escape",
    },
  ]);

  it("walks a large subtree with a bounded number of queries", async () => {
    const harness = createBashHarness();
    for (let index = 0; index < 120; index += 1) {
      await harness.fileSystem.writeFile(`/many/d${index % 6}/f${index}.txt`, "needle\n", {
        createParents: true,
      });
    }
    // The point of the paged walk is that the number of traversal queries does
    // not grow with the number of files; counting them is the only way to see
    // that, since a per-file query would give the same output.
    const findPage = harness.fileSystem.findPage.bind(harness.fileSystem);
    let queries = 0;
    harness.fileSystem.findPage = (options) => {
      queries += 1;
      return findPage(options);
    };
    const result = await harness.run("grep -rl needle /many | wc -l");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("120\n");
    expect(queries).toBeGreaterThan(0);
    expect(queries).toBeLessThanOrEqual(4);
  });
});

describe("sed profile", () => {
  const INPUT = "printf 'one\\ntwo\\nthree\\nfour\\n' | ";
  bashCases([
    { name: "prints a numbered record with -n", script: `${INPUT}sed -n '2p'`, stdout: "two\n" },
    {
      name: "deletes a numbered record",
      script: `${INPUT}sed '2d'`,
      stdout: "one\nthree\nfour\n",
    },
    { name: "selects a range", script: `${INPUT}sed -n '2,3p'`, stdout: "two\nthree\n" },
    {
      name: "selects by regular expression",
      script: `${INPUT}sed -n '/^t/p'`,
      stdout: "two\nthree\n",
    },
    { name: "selects the last record", script: `${INPUT}sed -n '$p'`, stdout: "four\n" },
    { name: "negates a selection", script: `${INPUT}sed -n '2!p'`, stdout: "one\nthree\nfour\n" },
    {
      name: "applies repeated expressions in order",
      script: `${INPUT}sed -e 's/one/1/' -e 's/two/2/'`,
      stdout: "1\n2\nthree\nfour\n",
    },
    {
      name: "expands a capture group and the whole match",
      script: String.raw`printf 'two\n' | sed 's/\(t\)wo/[\1]/'`,
      stdout: "[t]\n",
    },
    {
      name: "replaces only the requested occurrence",
      script: "printf 'oxoxo\\n' | sed 's/o/0/2'",
      stdout: "ox0xo\n",
    },
    {
      name: "replaces from the requested occurrence with g",
      script: "printf 'oxoxo\\n' | sed 's/o/0/2g'",
      stdout: "ox0x0\n",
    },
    {
      name: "refuses a command outside the subset",
      script: "printf 'x\\n' | sed 'y/a/b/'",
      exitCode: 2,
      stderrIncludes: "sed: unsupported command y",
    },
    {
      name: "refuses an unterminated expression",
      script: "printf 'x\\n' | sed 's/a/b'",
      exitCode: 2,
      stderrIncludes: "sed: unterminated expression",
    },
  ]);

  it("publishes an in-place edit as one guarded write", async () => {
    const harness = createBashHarness();
    await harness.fileSystem.writeFile("/edit.txt", "alpha\nbeta\n");
    harness.fileSystem.setMetadata("/edit.txt", { mode: 0o100640 });
    const before = harness.fileSystem.stat("/edit.txt");
    const result = await harness.run("sed -i 's/alpha/ALPHA/' /edit.txt");
    expect(result.exitCode).toBe(0);
    expect(await harness.readText("/edit.txt")).toBe("ALPHA\nbeta\n");
    const after = harness.fileSystem.stat("/edit.txt");
    // The edit republishes the file, so the revision moves and the mode stays.
    expect(after.revision).not.toBe(before.revision);
    expect(after.mode).toBe(0o100640);
  });

  it("refuses an in-place edit with no file operand", async () => {
    const harness = createBashHarness();
    const result = await harness.run("printf 'x\\n' | sed -i 's/x/y/'");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("sed: -i requires a file operand");
  });

  it("leaves the file untouched when a concurrent write wins", async () => {
    const harness = createBashHarness();
    await harness.fileSystem.writeFile("/race.txt", "alpha\n");
    // A competing writer lands in the window between the token `sed -i` takes
    // and the publication it guards, which is the whole point of the token.
    const writeFile = harness.fileSystem.writeFile.bind(harness.fileSystem);
    let raced = false;
    harness.fileSystem.writeFile = async (path, data, options) => {
      if (!raced && path === "/race.txt" && options?.ifMutationToken !== undefined) {
        raced = true;
        await writeFile(path, "changed\n");
      }
      return writeFile(path, data, options);
    };
    const result = await harness.run("sed -i 's/alpha/beta/' /race.txt");
    expect(raced).toBe(true);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("sed: /race.txt:");
    // The edit is refused whole rather than overwriting the winner.
    expect(await harness.readText("/race.txt")).toBe("changed\n");
  });

  it("edits the remaining operands after one fails", async () => {
    const harness = createBashHarness();
    await harness.fileSystem.writeFile("/k1.txt", "x\n");
    await harness.fileSystem.writeFile("/k2.txt", "x\n");
    const result = await harness.run("sed -i 's/x/X/' /k1.txt /missing.txt /k2.txt");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("sed: /missing.txt:");
    expect(await harness.readText("/k1.txt")).toBe("X\n");
    expect(await harness.readText("/k2.txt")).toBe("X\n");
  });
});

describe("find actions", () => {
  bashCases([
    {
      name: "separates matches with NUL under -print0",
      files: TREE,
      script: "find /t -name 'a.txt' -print0 | wc -c",
      stdout: "9\n",
    },
    {
      name: "runs a command once per match",
      files: TREE,
      script: "find /t -name '*.txt' -exec cat {} ';' | sort",
      stdout: "alpha\nalpha\nbeta\ngamma\n",
    },
    {
      name: "batches matches into one invocation",
      files: TREE,
      script: "find /t -name '*.txt' -exec cat {} + | sort",
      stdout: "alpha\nalpha\nbeta\ngamma\n",
    },
    {
      name: "does not fail when a ; invocation does, and does when a + one does",
      files: TREE,
      // POSIX: with `;` the status of each command is `find`'s business and not
      // its result. Only the `+` form propagates a failure.
      script:
        "find /t -name '*.txt' -exec false {} ';'; printf '%s' \"$?\"; " +
        "find /t -name '*.txt' -exec false {} +; printf '%s' \"$?\"",
      stdout: "01",
    },
    {
      name: "substitutes {} everywhere in a word, not only on its own",
      files: TREE,
      script: "find /t -name 'a.txt' -exec printf '[%s]' 'pre{}post' ';'",
      stdout: "[pre/t/a.txtpost]",
    },
    {
      name: "requires a terminator",
      files: TREE,
      script: "find /t -exec cat {}",
      exitCode: 2,
      stderrIncludes: "find: -exec requires ; or +",
    },
    {
      name: "requires {} last when batching",
      files: TREE,
      script: "find /t -exec cat {} extra +",
      exitCode: 2,
      stderrIncludes: "find: -exec ... + requires {} as the last argument",
    },
    {
      name: "refuses -exec beside a print action",
      files: TREE,
      script: "find /t -print -exec cat {} ';'",
      exitCode: 2,
      stderrIncludes: "find: specify either -exec or a print action",
    },
  ]);

  it("runs -exec through the command policy", async () => {
    const harness = createBashHarness({ policy: { allowedCommands: ["find", "printf"] } });
    await harness.fileSystem.writeFile("/t/a.txt", "body", { createParents: true });
    const result = await harness.run("find /t -name '*.txt' -exec cat {} ';'");
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("command is not allowed: cat");
  });
});

describe("listing and metadata", () => {
  bashCases([
    {
      name: "lists one entry per line",
      files: TREE,
      script: "ls -1 /t",
      stdout: "a.txt\nc.log\nsub\n",
    },
    {
      name: "walks a subtree with -R",
      files: TREE,
      script: "ls -R /t",
      stdout: "/t:\na.txt\nc.log\nsub\n\n/t/sub:\nb.txt\n",
    },
    {
      name: "names the operand as written under -d",
      files: TREE,
      script: "ls -d /t/sub",
      stdout: "/t/sub\n",
    },
    {
      name: "prints selected metadata fields",
      files: { "/f": "body\n" },
      script: "chmod 644 /f; stat -c '%s %a %F' /f",
      stdout: "5 644 regular file\n",
    },
    {
      name: "refuses a field this namespace does not have",
      files: { "/f": "body\n" },
      script: "stat -c '%u' /f",
      exitCode: 2,
      stderrIncludes: "stat: unsupported conversion %u",
    },
    {
      name: "preserves mode bits with cp -p",
      files: { "/src": "body\n" },
      script: "chmod 751 /src; cp -p /src /dst; stat -c '%a' /dst",
      stdout: "751\n",
    },
  ]);
});

describe("small deterministic utilities", () => {
  bashCases([
    { name: "evaluates integer arithmetic", script: "expr 2 + 3", stdout: "5\n" },
    { name: "truncates integer division", script: "expr 7 / 2", stdout: "3\n" },
    {
      name: "reports a false comparison with status 1",
      script: "expr 1 = 2; printf '%s' \"$?\"",
      stdout: "0\n1",
    },
    { name: "compares strings by byte order", script: "expr abc '<' abd", stdout: "1\n" },
    { name: "measures a string", script: "expr length hello", stdout: "5\n" },
    {
      name: "refuses division by zero",
      script: "expr 1 / 0",
      exitCode: 2,
      stderrIncludes: "expr: division by zero",
    },
    {
      name: "refuses an operator outside the profile",
      script: "expr 2 '^' 3",
      exitCode: 2,
      stderrIncludes: "expr: unsupported operator",
    },
    { name: "returns immediately from a zero sleep", script: "sleep 0; printf ok", stdout: "ok" },
    {
      name: "refuses a fractional duration",
      script: "sleep 0.5",
      exitCode: 2,
      stderrIncludes: "sleep: duration must be a whole number of seconds",
    },
  ]);

  it("prints the injected clock rather than a host clock", async () => {
    const harness = createBashHarness({ now: () => 1_700_000_000_000 });
    expect((await harness.run("date +%F")).stdout).toBe("2023-11-14\n");
    expect((await harness.run("date +%s")).stdout).toBe("1700000000\n");
    expect((await harness.run("date")).stdout).toBe("2023-11-14 22:13:20 UTC\n");
  });

  it("refuses a sleep that could not finish inside the deadline", async () => {
    const harness = createBashHarness({ limits: { deadlineMs: 500 } });
    const result = await harness.run("sleep 5");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("sleep: duration exceeds the remaining execution deadline");
  });

  it("wakes a sleep when the execution is cancelled", async () => {
    const harness = createBashHarness();
    const controller = new AbortController();
    const started = Date.now();
    const running = harness.run("sleep 20; printf finished", { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const result = await running;
    expect(result.stdout).toBe("");
    // A cancelled execution reports failure rather than succeeding silently,
    // and the statement after the sleep never runs.
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { compilePosixRegex } from "../src/core/posix-regex.js";
import { bashCases, createBashHarness } from "./helpers/bash.js";

const TREE = {
  "/t/a.txt": "alpha\nbeta\n",
  "/t/sub/b.txt": "gamma\nalpha\n",
  "/t/c.log": "nothing\n",
};

afterEach(() => vi.useRealTimers());

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

describe("sort profile", () => {
  bashCases([
    {
      name: "keeps the first input spelling when numeric unique keys compare equal",
      script: "printf '2\\n02\\n' | sort -nu",
      stdout: "2\n",
    },
  ]);
});

describe("tr profile", () => {
  bashCases([
    {
      name: "treats a lone hyphen as a literal set member",
      script: "printf 'a-b' | tr '-' '_'",
      stdout: "a_b",
    },
  ]);

  it("bounds character-range materialization", async () => {
    const result = await createBashHarness({ limits: { maxExpansionChars: 100 } }).run(
      "tr 'Ā-Ȁ' x",
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("tr: character set exceeds the expansion limit");
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

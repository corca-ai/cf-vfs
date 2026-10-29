import { describe } from "vitest";
import { bashCases } from "./helpers/bash.js";

// Text utilities an agent reached for while maintaining a Markdown wiki, each
// pinned to what GNU coreutils and sed do.

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

describe("sed programs", () => {
  const page = { "/f": "---\ntitle: Deploy Guide\ntags: [a]\n---\n# Deploy Guide\ntitle: keep\n" };
  bashCases([
    {
      name: "branches past a range to edit only frontmatter",
      files: page,
      script: "sed -e '1,/^---$/!b' -e 's/^title: .*/title: X/' /f",
      stdout: "---\ntitle: X\ntags: [a]\n---\n# Deploy Guide\ntitle: keep\n",
    },
    {
      name: "runs a block for an addressed range",
      files: page,
      script: "sed -n '/^#/{=;p}' /f; sed '/^---$/,/^---$/{s/^tags: .*/tags: [b]/}' /f | sed -n 3p",
      stdout: "5\n# Deploy Guide\ntags: [b]\n",
    },
    {
      name: "joins every line with a label loop",
      script: "printf 'a\\nb\\nc\\n' | sed ':a;N;$!ba;s/\\n/,/g'",
      stdout: "a,b,c\n",
    },
    {
      name: "reverses lines through the hold space",
      script: "printf 'a\\nb\\nc\\n' | sed '1!G;h;$!d'",
      stdout: "c\nb\na\n",
    },
    {
      name: "inserts, appends and changes text",
      script:
        "printf 'a\\nb\\n' | sed '1i\\\nfirst'; printf 'a\\nb\\n' | sed '/a/a after a'; printf 'a\\nb\\nc\\nd\\n' | sed '2,3c X'",
      stdout: "first\na\nb\na\nafter a\nb\na\nX\nd\n",
    },
    {
      name: "transliterates and uses -r",
      script: "printf 'hello\\n' | sed 'y/ehl/EHL/'; printf 'x1\\n' | sed -r 's/x([0-9])/y\\1/'",
      stdout: "HELLo\ny1\n",
    },
    {
      name: "reads ahead with n, N, P and D",
      script: "printf 'a\\nb\\nc\\n' | sed -n 'n;p'; printf 'a\\nb\\nc\\n' | sed '$!N;P;D'",
      stdout: "b\na\nb\nc\n",
    },
    {
      name: "branches on substitution with t and T",
      script:
        "printf 'aaa\\n' | sed ':x;s/a/b/;tx'; printf 'ab\\n' | sed 's/z/y/;T;s/a/A/'; printf 'ab\\n' | sed 's/a/q/;T;s/b/B/'",
      stdout: "bbb\nab\nqB\n",
    },
    {
      name: "keeps an unterminated last line unterminated, but not appended text",
      script:
        "printf 'a\\nb' | sed '$d'; echo '|'; printf 'a\\nb' | sed p; echo '|'; printf 'a\\nb' | sed '$a z'; echo '|'",
      stdout: "a\n|\na\na\nb\nb|\na\nb\nz\n|\n",
    },
    {
      name: "edits in place with an appended line",
      files: { "/g": "# Title\nbody\n" },
      script: "sed -i '/^# Title/a\\\nadded' /g && cat /g",
      stdout: "# Title\nadded\nbody\n",
    },
    {
      name: "bounds an endless branch loop",
      script: "printf 'x\\n' | sed ':a;ba'",
      exitCode: 1,
      stderrIncludes: "step limit exceeded",
    },
    {
      name: "refuses a missing label",
      script: "printf 'x\\n' | sed 'b nowhere'",
      exitCode: 2,
      stderrIncludes: "can't find label nowhere",
    },
  ]);
});

describe("od, basename, uniq and printf escapes", () => {
  bashCases([
    {
      name: "dumps characters",
      script: "printf 'a\\nb' | od -c",
      stdout: "0000000   a  \\n   b\n0000003\n",
    },
    {
      name: "dumps octal words by default",
      script: "printf 'a\\nb' | od",
      stdout: "0000000 005141 000142\n0000003\n",
    },
    {
      name: "dumps hex bytes without addresses",
      script: "printf 'hello\\n' | od -An -tx1",
      stdout: " 68 65 6c 6c 6f 0a\n",
    },
    {
      name: "aligns several formats and prints the z column",
      script: "printf 'a\\tb' | od -t x1 -c; printf 'hi\\n' | od -A x -t x1z",
      stdout:
        "0000000  61  09  62\n          a  \\t   b\n0000003\n000000 68 69 0a                                         >hi.<\n000003\n",
    },
    {
      name: "folds repeated lines",
      script: "printf '%032d' 0 | od -c",
      stdout: `0000000${"   0".repeat(16)}\n*\n0000040\n`,
    },
    {
      name: "removes a suffix from basename",
      script:
        "basename /a/b/page.md .md; basename -s .md a.md b/c.md; basename -a x/y z/; basename .md .md",
      stdout: "page\na\nc\ny\nz\n.md\n",
    },
    {
      name: "compares a prefix, skipped fields, and case with uniq",
      script:
        "printf 'a 1\\na 2\\nb 3\\n' | uniq -w1 -c; printf 'x\\nx\\ny\\n' | uniq -d; printf 'x\\nx\\ny\\n' | uniq -u; printf 'A\\na\\n' | uniq -i; printf '1 a\\n2 a\\n' | uniq -f1 -c",
      stdout: "      2 a 1\n      1 b 3\nx\ny\nA\n      2 1 a\n",
    },
    {
      name: "decodes octal, hex and unicode escapes in a printf format",
      script: "printf '\\101\\x42\\u00e9\\q\\n'; printf '%b' 'x\\0101y\\n'",
      stdout: "ABé\\q\nxAy\n",
    },
  ]);
});

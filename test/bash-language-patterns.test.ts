import { expect, it } from "vitest";
import { type BashCase, bashCases, bashSuite, createBashHarness } from "./helpers/bash.js";

bashSuite("Bash v3 bounded parameter patterns and substrings", [
  {
    name: "removes the shortest and longest matching prefixes",
    script: 'X=abcabc; printf \'<%s>|<%s>\' "${X#a*c}" "${X##a*c}"',
    stdout: "<abc>|<>",
  },
  {
    name: "removes the shortest and longest matching suffixes",
    script: 'X=abcabc; printf \'<%s>|<%s>\' "${X%a*}" "${X%%a*}"',
    stdout: "<abc>|<>",
  },
  {
    name: "leaves values unchanged for missing and empty patterns",
    script: 'X=abc; printf \'<%s>|<%s>|<%s>\' "${X#z*}" "${X#}" "${X//}"',
    stdout: "<abc>|<abc>|<abc>",
  },
  {
    name: "honors quoted and escaped pattern metacharacters",
    script: "X='a*b'; P='a*'; printf '<%s>|<%s>|<%s>' \"${X#'a*'}\" \"${X#a\\*}\" \"${X##$P}\"",
    stdout: "<b>|<b>|<>",
  },
  {
    name: "supports bracket ranges and negated classes without pathname rules",
    script: 'X=\'a/b2\'; printf \'<%s>|<%s>|<%s>\' "${X#[a-z]}" "${X#?[/]}" "${X##[!z]*}"',
    stdout: "</b2>|<b2>|<>",
  },
  {
    name: "expands nested words in removal patterns",
    script: "X=abcabc; PREFIX=a; printf '%s' \"${X##${PREFIX}*}\"",
    stdout: "",
  },
  {
    name: "replaces the first longest match and every non-overlapping match",
    script: 'X=abcabc; printf \'<%s>|<%s>|<%s>\' "${X/a*c/R}" "${X//a?/R}" "${X//?/R}"',
    stdout: "<R>|<RcRc>|<RRRRRR>",
  },
  {
    name: "supports deletion, nested replacement expansion, and no-match replacement",
    script: 'X=abcabc; R=Z; printf \'<%s>|<%s>|<%s>\' "${X//a}" "${X//a/${R:-x}}" "${X//z*/R}"',
    stdout: "<bcbc>|<ZbcZbc>|<abcabc>",
  },
  {
    name: "escapes replacement delimiters and quoted pattern stars",
    script: "X='a/b/a'; printf '<%s>|' \"${X//\\//:}\"; X='a*b'; printf '<%s>' \"${X/'*'/X}\"",
    stdout: "<a:b:a>|<aXb>",
  },
  {
    name: "handles Unicode pattern replacements by code point",
    script: "X='가나다가'; printf '<%s>' \"${X//가/X}\"",
    stdout: "<X나다X>",
  },
  {
    name: "slices by code point with positive, negative, and nested offsets",
    script:
      'X=\'가나다라마바사\'; OFFSET=2; printf \'<%s>|<%s>|<%s>|<%s>\' "${X:1}" "${X:1:3}" "${X: -2}" "${X:${OFFSET}:2}"',
    stdout: "<나다라마바사>|<나다라>|<바사>|<다라>",
  },
  {
    name: "clamps substring offsets and accepts zero length",
    script: 'X=abc; printf \'<%s>|<%s>|<%s>\' "${X:99}" "${X: -99}" "${X:1:0}"',
    stdout: "<>|<abc>|<>",
  },
  {
    name: "treats unset and empty scalar values as empty",
    script: 'unset X; EMPTY=; printf \'<%s>|<%s>|<%s>\' "${X##*}" "${EMPTY//a/b}" "${X:0:2}"',
    stdout: "<>|<>|<>",
  },
  {
    name: "preserves quoted and unquoted field behavior after slicing",
    script: "X='a b'; printf '<%s>\\n' ${X:0}; printf '[%s]' \"${X:0}\"",
    stdout: "<a>\n<b>\n[a b]",
  },
  {
    name: "applies pathname expansion after an unquoted pattern result",
    files: { "/g/a": "", "/g/b": "" },
    script: "X='/g/*tail'; printf '<%s>\\n' ${X%tail}",
    stdout: "</g/a>\n</g/b>\n",
  },
  {
    name: "rejects negative and non-integer substring lengths deterministically",
    script:
      "X=abc; printf '%s' \"${X:0:-1}\" || printf '%s|' \"$?\"; LENGTH=x; printf '%s' \"${X:0:${LENGTH}}\"",
    exitCode: 2,
    stdout: "2|",
    stderrIncludes: ["must not be negative", "must expand to an integer"],
  },
  {
    name: "keeps Version 2 default operators on the at parameter",
    args: ["argument"],
    script: 'printf \'<%s>|<%s>\' "${@:-fallback}" "${@+set}"',
    stdout: "<argument>|<set>",
  },
]);

it("bounds pattern work, produced characters, and produced fields", async () => {
  const work = createBashHarness({ limits: { maxExpansionWork: 20 } });
  await expect(work.run("X=aaaaaaaa; printf '%s' \"${X##*a*a*a*a*a*b}\"")).resolves.toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining("shell expansion work limit exceeded"),
  });

  const characters = createBashHarness({ limits: { maxExpansionChars: 20 } });
  await expect(characters.run("X=aaaa; printf '%s' \"${X//a/xxx}\"")).resolves.toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining("shell expansion character limit exceeded"),
  });

  const fields = createBashHarness({ limits: { maxExpansionFields: 4 } });
  await expect(fields.run("printf '%s' \"$@\"", { args: ["a", "b", "c"] })).resolves.toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining("shell expansion field limit exceeded"),
  });

  const splitFields = createBashHarness({ limits: { maxExpansionFields: 4 } });
  await expect(
    splitFields.run(": $X", {
      env: { X: Array.from({ length: 100 }, (_, index) => String(index)).join(" ") },
    }),
  ).resolves.toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining("shell expansion field limit exceeded"),
  });

  const bracketWork = createBashHarness({ limits: { maxExpansionWork: 500 } });
  await expect(
    bracketWork.run(`printf '%s' "${"${X//["}${"a".repeat(200)}${"]/x}"}"`, {
      env: { X: "b".repeat(20) },
    }),
  ).resolves.toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining("shell expansion work limit exceeded"),
  });

  const substringWork = createBashHarness({ limits: { maxExpansionWork: 100 } });
  await expect(
    substringWork.run("printf '%s' \"${X:99:1}\"", {
      env: { X: "a".repeat(1_000) },
    }),
  ).resolves.toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining("shell expansion work limit exceeded"),
  });
});

bashCases([
  {
    name: "rejects too many substring separators before an earlier mutation",
    script: "printf changed > /side; printf '%s' \"${X:1:2:3}\"",
    exitCode: 2,
    stderrIncludes: "at most one length",
    missingFiles: ["/side"],
  },
  {
    name: "rejects an empty substring offset before an earlier mutation",
    script: "printf changed > /side; printf '%s' \"${X:}\"",
    exitCode: 2,
    stderrIncludes: "must not be empty",
    missingFiles: ["/side"],
  },
  {
    name: "rejects an explicitly empty substring offset",
    script: "printf changed > /side; printf '%s' \"${X::1}\"",
    exitCode: 2,
    stderrIncludes: "must not be empty",
    missingFiles: ["/side"],
  },
  {
    name: "rejects an explicitly empty substring length",
    script: "printf changed > /side; printf '%s' \"${X:1:}\"",
    exitCode: 2,
    stderrIncludes: "must not be empty",
    missingFiles: ["/side"],
  },
  {
    name: "rejects a leading plus in a substring operand",
    script: "X=abc; printf '%s' \"${X: +1}\"",
    exitCode: 2,
    stderrIncludes: "must expand to an integer",
  },
  {
    name: "rejects anchored replacement before an earlier mutation",
    script: "printf changed > /side; printf '%s' \"${X/#a/b}\"",
    exitCode: 2,
    stderrIncludes: "anchored parameter replacement is not supported",
    missingFiles: ["/side"],
  },
  {
    name: "rejects array-style slicing before an earlier mutation",
    script: "printf changed > /side; printf '%s' \"${@:1}\"",
    exitCode: 2,
    stderrIncludes: "array-style parameter operations are not supported",
    missingFiles: ["/side"],
  },
]);

const operatorCases: ReadonlyArray<readonly [name: string, expression: string, output: string]> = [
  ["associates exponentiation from the right", "2 ** 3 ** 2", "512"],
  ["shifts left", "8 << 2", "32"],
  ["shifts signed values right", "-8 >> 1", "-4"],
  ["evaluates bitwise and", "6 & 3", "2"],
  ["evaluates bitwise xor", "6 ^ 3", "5"],
  ["evaluates bitwise or", "6 | 3", "7"],
  ["evaluates remainder", "5 % 2", "1"],
  ["divides signed integers toward zero", "-5 / 2", "-2"],
  ["normalizes true comparisons to one", "3 < 4", "1"],
  ["normalizes false comparisons to zero", "3 >= 4", "0"],
  [
    "maps every compound assignment to its binary operation",
    "N=8, N+=2, N-=3, N*=4, N/=2, N%=5, N<<=2, N>>=1, N&=6, N^=3, N|=8, N",
    "11",
  ],
];

bashSuite(
  "Bash v2 arithmetic operators",
  operatorCases.map(
    ([name, expression, output]): BashCase => ({
      name,
      script: `printf '%s' "$(( ${expression} ))"`,
      stdout: output,
    }),
  ),
);

bashSuite("Bash v2 arithmetic", [
  {
    name: "applies multiplication before addition",
    script: `printf '%s' "$((2 + 3 * 4))"`,
    stdout: "14",
  },
  {
    name: "honors arithmetic parentheses",
    script: `printf '%s' "$(((2 + 3) * 4))"`,
    stdout: "20",
  },
  { name: "accepts hexadecimal literals", script: `printf '%s' "$((0x10 + 1))"`, stdout: "17" },
  {
    name: "interprets leading-zero literals and variable values as octal",
    script: `VALUE=010; printf '%s|%s' "$((010))" "$((VALUE))"`,
    stdout: "8|8",
  },
  {
    name: "supports logical and bitwise unary operators",
    script: `printf '%s|%s' "$((!0))" "$((~0))"`,
    stdout: "1|-1",
  },
  {
    name: "persists assignment and prefix update side effects",
    script: `N=2; printf '%s|' "$((N *= 3))"; printf '%s|' "$((++N))"; printf '%s' "$N"`,
    stdout: "6|7|7",
  },
  {
    name: "returns the old value from a postfix update",
    script: `N=4; printf '%s|' "$((N++))"; printf '%s' "$N"`,
    stdout: "4|5",
  },
  {
    name: "short-circuits logical operators",
    script: `printf '%s|%s' "$((0 && 1 / 0))" "$((1 || 1 / 0))"`,
    stdout: "0|1",
  },
  {
    name: "evaluates only the selected conditional branch",
    script: `printf '%s|%s' "$((1 ? 7 : 1 / 0))" "$((0 ? 1 / 0 : 8))"`,
    stdout: "7|8",
  },
  {
    name: "returns the last comma expression",
    script: `printf '%s' "$((1, 2, 3))"`,
    stdout: "3",
  },
  {
    name: "wraps deterministically at signed 64 bits",
    script: `printf '%s' "$((9223372036854775807 + 1))"`,
    stdout: "-9223372036854775808",
  },
  {
    name: "reads non-numeric variable text as zero",
    script: `X=text; printf '%s' "$((X + 2))"`,
    stdout: "2",
  },
  {
    name: "maps arithmetic command truth to shell status",
    script: `((0)) || printf zero; ((1)) && printf one`,
    stdout: "zeroone",
  },
  {
    name: "isolates arithmetic mutations in a subshell",
    script: `N=1; ((N += 1)); (printf '%s|' "$((N += 3))"); printf '%s' "$N"`,
    stdout: "5|2",
  },
  {
    name: "reports division by zero as a shell usage failure",
    script: "((1 / 0))",
    exitCode: 2,
    stderrIncludes: "division by zero",
  },
  {
    name: "rejects an invalid octal literal before an earlier mutation",
    script: `printf changed > /side; printf '%s' "$((08))"`,
    exitCode: 2,
    stderrIncludes: "invalid octal literal",
    missingFiles: ["/side"],
  },
  {
    name: "rejects a negative arithmetic exponent",
    script: `printf changed > /side; printf '%s' "$((2 ** -1))"`,
    exitCode: 2,
    stderrIncludes: "negative",
    expectedFiles: { "/side": "changed" },
  },
]);

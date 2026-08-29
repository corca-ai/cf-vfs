import { describe, expect, it } from "vitest";
import { parseShellScript } from "../src/shell/parser.js";
import { type BashCase, bashSuite, createBashHarness } from "./helpers/bash.js";

const rejectedConditionals: ReadonlyArray<readonly [string, string, string]> = [
  ["regex matching", "[[ x =~ x ]]", "unsupported [[ operator =~"],
  ["unsupported metadata predicates", "[[ -O /side ]]", "unsupported [[ unary operator -O"],
  ["timestamp comparisons", "[[ /left -nt /right ]]", "unsupported [[ operator -nt"],
  ["a missing expression", "[[ ]]", "[[ expression is missing"],
  ["a missing unary operand", "[[ -n ]]", "[[ operand for -n is missing"],
  ["a missing binary operand", "[[ x == ]]", "[[ right operand for == is missing"],
  ["a dangling boolean operator", "[[ x && ]]", "[[ expression is missing"],
  ["an unmatched conditional group", "[[ ( x ]]", "[[ expected )"],
  ["an unexpected operand", "[[ x y ]]", "unsupported [[ operator y"],
  ["an unterminated expression", "[[ x == x", "unterminated [["],
];

bashSuite("Bash v3 bounded double-bracket conditionals", [
  {
    name: "supports word truth and unary string predicates without splitting",
    env: { VALUE: "two words", EMPTY: "" },
    script: "[[ $VALUE ]] && [[ -n $VALUE ]] && [[ -z $EMPTY ]] && printf yes",
    stdout: "yes",
  },
  {
    name: "does not perform pathname expansion on conditional operands",
    files: { "/g/a": "a", "/g/b": "b" },
    env: { VALUE: "/g/*" },
    script: "[[ $VALUE == '/g/*' ]] && printf '%s' \"$VALUE\"",
    stdout: "/g/*",
  },
  {
    name: "uses an unquoted equality right operand as a bounded shell pattern",
    script: "PATTERN='a*'; [[ abc == $PATTERN ]] && [[ abc != z* ]] && printf yes",
    stdout: "yes",
  },
  {
    name: "makes quoted and escaped pattern fragments literal",
    script: "PATTERN='a*'; [[ abc != \"$PATTERN\" ]] && [[ 'a*' == a\\* ]] && printf yes",
    stdout: "yes",
  },
  {
    name: "supports deterministic UTF-8 lexical comparisons",
    script: "[[ alpha < beta ]] && [[ beta > alpha ]] && [[ é > z ]] && printf yes",
    stdout: "yes",
  },
  {
    name: "supports every strict-decimal integer comparison",
    script: [
      "[[ 01 -eq 1 ]]",
      "[[ 1 -ne 2 ]]",
      "[[ -2 -lt -1 ]]",
      "[[ -1 -le -1 ]]",
      "[[ 900719925474099300000 -gt 900719925474099299999 ]]",
      "[[ 2 -ge 2 ]]",
      "printf yes",
    ],
    stdout: "yes",
  },
  {
    name: "applies not, grouping, and and-before-or precedence",
    script: "[[ x || '' && '' ]] && [[ ( x == y || x == x ) && ! ( -z x ) ]] && printf yes",
    stdout: "yes",
  },
  {
    name: "accepts physical newlines after the opener and boolean operators",
    script: "[[\nx == x &&\ny == y ]] && printf yes",
    stdout: "yes",
  },
  {
    name: "short-circuits unevaluated nounset operands",
    script: "set -u; [[ x == x || $MISSING ]] && [[ x != x && $MISSING ]] || printf safe",
    stdout: "safe",
  },
  {
    name: "expands command substitutions only in evaluated branches",
    script: "[[ $(printf abc) == a* || $(printf no) == no ]] && printf yes",
    stdout: "yes",
  },
  {
    name: "uses canonical VFS metadata for files and directories",
    files: { "/tree/file": "body" },
    script:
      "cd /tree; [[ -e ./file && -f ../tree/file && -d . && ! -e missing && ! -e '' ]] && printf yes",
    stdout: "yes",
  },
  {
    name: "preserves trailing-slash directory requirements in metadata tests",
    files: { "/plain": "body", "/tree/file": "body" },
    script: "[[ ! -e /plain/ && ! -f /plain/ && -e /tree/ && -d /tree/ ]] && printf yes",
    stdout: "yes",
  },
  {
    name: "works as an if condition and returns ordinary status",
    script:
      "if [[ value == v* ]]; then printf yes; else printf no; fi; [[ no == yes ]] || printf ':false'",
    stdout: "yes:false",
  },
  {
    name: "supports compound-command redirections",
    script: "[[ x == x ]] > /condition; [[ -f /condition ]] && printf yes",
    stdout: "yes",
    expectedFiles: { "/condition": "" },
  },
  {
    name: "reports invalid expanded integers as a status-2 semantic failure",
    env: { VALUE: "not-an-integer" },
    script: "printf changed > /side; [[ $VALUE -eq 1 ]] || printf 'status=%s' \"$?\"",
    stdout: "status=2",
    stderr: "[[: integer expression expected\n",
    expectedFiles: { "/side": "changed" },
  },
  {
    name: "sends conditional semantic diagnostics through redirected stderr",
    script: "[[ invalid -eq 1 ]] 2> /error || printf '%s|' \"$?\"; cat /error",
    stdout: "2|[[: integer expression expected\n",
    expectedFiles: { "/error": "[[: integer expression expected\n" },
  },
]);

bashSuite(
  "Bash v3 rejected double-bracket conditionals",
  rejectedConditionals.map(
    ([name, syntax, diagnostic]): BashCase => ({
      name: `rejects ${name} before an earlier mutation`,
      script: `printf changed > /side; ${syntax}`,
      exitCode: 2,
      stderrIncludes: diagnostic,
      missingFiles: ["/side"],
    }),
  ),
);

describe("Bash v3 conditional AST", () => {
  it("preserves right-operand quote provenance in the public conditional AST", () => {
    const parsed = parseShellScript(`[[ value == "a"* ]]`, 100);
    const command = parsed.lists[0]?.first.commands[0];
    expect(command?.type).toBe("double-bracket");
    if (command?.type !== "double-bracket") throw new Error("expected double-bracket AST");
    expect(command.expression.type).toBe("conditional-binary");
    if (command.expression.type !== "conditional-binary") {
      throw new Error("expected conditional-binary AST");
    }
    expect(command.expression.right.parts).toEqual([
      { kind: "literal", value: "a", quoted: true },
      { kind: "literal", value: "*", quoted: false },
    ]);
  });
});

describe("Bash v3 conditional execution limits", () => {
  it("charges conditional patterns to the shared expansion-work budget", async () => {
    const { shell } = createBashHarness({ limits: { maxExpansionWork: 5 } });
    await expect(shell.executeText({ script: "[[ abc == a* ]]" })).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("shell expansion work limit exceeded"),
    });
  });

  it("charges conditional expressions to the shared AST-node budget before execution", async () => {
    const { shell, fileSystem } = createBashHarness({ limits: { maxAstNodes: 12 } });
    const result = await shell.executeText({
      script: "printf changed > /side; [[ x && x && x && x && x ]]",
    });
    expect(result).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("shell AST node limit exceeded"),
    });
    expect(() => fileSystem.stat("/side")).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("charges nested conditional groups to the shared nesting limit", async () => {
    const { shell } = createBashHarness({ limits: { maxNestingDepth: 3 } });
    await expect(shell.executeText({ script: "[[ ( ( ( x ) ) ) ]]" })).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("shell nesting depth limit exceeded"),
    });
  });

  it("evaluates long bounded boolean chains without using the JavaScript call stack", async () => {
    const { shell } = createBashHarness();
    const expression = Array.from({ length: 3_000 }, () => "x").join(" && ");
    await expect(shell.executeText({ script: `[[ ${expression} ]]` })).resolves.toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });

  it("starts the shared execution deadline while parsing a submitted unit", async () => {
    let clockReads = 0;
    const { shell, fileSystem } = createBashHarness({
      limits: { deadlineMs: 50 },
      now: () => (++clockReads > 4 ? 100 : 0),
    });
    const result = await shell.executeText({
      script: `printf changed > /side; [[ ${"x".repeat(20_000)} ]]`,
    });
    expect(result.exitCode).toBe(1);
    expect(() => fileSystem.stat("/side")).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });
});

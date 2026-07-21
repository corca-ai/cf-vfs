import { describe, expect, it } from "vitest";
import { defineCommand } from "../src/shell/commands/helpers.js";
import { parseShellScript } from "../src/shell/parser.js";
import { bashCases, createBashHarness, type BashCase } from "./helpers/bash.js";

describe("Bash v2 words, assignments, and statuses", () => {
  bashCases([
    {
      name: "expands double quotes but preserves single-quoted dollars",
      script: `printf '<%s>|<%s>' "$NAME" '$NAME'`,
      env: { NAME: "expanded" },
      stdout: "<expanded>|<$NAME>",
    },
    {
      name: "preserves an escaped dollar in double quotes",
      script: `printf '<%s>' "\\$HOME"`,
      env: { HOME: "/home/test" },
      stdout: "<$HOME>",
    },
    {
      name: "splits an unquoted variable on fixed whitespace IFS",
      script: `printf '<%s>\n' $FIELDS`,
      env: { FIELDS: "left right\nthird" },
      stdout: "<left>\n<right>\n<third>\n",
    },
    {
      name: "keeps a quoted empty field and removes an unquoted unset field",
      script: `unset X; printf '[%s]\n' "$X"; printf '<%s>\n' before $X after`,
      stdout: "[]\n<before>\n<after>\n",
    },
    {
      name: "expands quoted $@ to one field per positional argument",
      script: `printf '<%s>\n' "$@"`,
      args: ["one", "two words", "three"],
      stdout: "<one>\n<two words>\n<three>\n",
    },
    {
      name: "expands quoted $@ to no fields without positional arguments",
      script: `count() { printf '<%s>' "$#"; }; count "$@"`,
      stdout: "<0>",
    },
    {
      name: "preserves empty positional arguments in quoted $@",
      script: `show() { printf '<%s>' "$#"; for value; do printf '|<%s>' "$value"; done; }; show "$@"`,
      args: ["", "two words"],
      stdout: "<2>|<>|<two words>",
    },
    {
      name: "lets another quoted fragment preserve an empty word next to empty $@",
      script: `count() { printf '<%s>' "$#"; }; count "$@"""`,
      stdout: "<1>",
    },
    {
      name: "attaches surrounding quoted text to the first and last $@ fields",
      script: `printf '<%s>\n' "pre$@post"`,
      args: ["one", "two", "three"],
      stdout: "<preone>\n<two>\n<threepost>\n",
    },
    {
      name: "splits every unquoted $@ positional argument",
      script: `printf '<%s>\n' $@`,
      args: ["one two", "three"],
      stdout: "<one>\n<two>\n<three>\n",
    },
    {
      name: "distinguishes $10 from ${10}",
      script: `printf '%s|%s' "$10" "\${10}"`,
      args: ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"],
      stdout: "one0|ten",
    },
    {
      name: "starts comments only at word boundaries",
      script: "printf '%s\\n' hash#value # ignored\nprintf done",
      stdout: "hash#value\ndone",
    },
    {
      name: "removes escaped physical newlines before word formation",
      script: "printf '%s' one\\\ntwo",
      stdout: "onetwo",
    },
    {
      name: "does not split or glob assignment right-hand sides",
      script: "mkdir /g; touch /g/a; X='/g/* left'; Y=$X; printf '<%s>' \"$Y\"",
      stdout: "</g/* left>",
    },
    {
      name: "lets consecutive assignments observe earlier assignments",
      script: `unset C D; C=one D=$C; printf '%s|%s' "$C" "$D"`,
      stdout: "one|one",
    },
    {
      name: "updates $? after each completed list",
      script: `false; printf '%s|' "$?"; true; printf '%s' "$?"`,
      stdout: "1|0",
    },
    {
      name: "formats exact Bash integer arguments and reports invalid suffixes",
      script: "printf '[%d]|[%d]|[%d]|[%d]|[%d]|[%d]|[%d]' 9007199254740993 010 0x10 nope 08 +10 '2#10' 2> /errors; printf '|status=%s' \"$?\"",
      stdout: "[9007199254740993]|[8]|[16]|[0]|[0]|[10]|[2]|status=1",
      expectedFiles: {
        "/errors": "printf: nope: invalid number\nprintf: 08: invalid octal number\nprintf: 2#10: invalid number\n",
      },
    },
    {
      name: "preserves unknown printf format and percent-b escapes",
      script: `printf '\\q|%b' '\\q'`,
      stdout: "\\q|\\q",
    },
    {
      name: "compares large test integers without precision loss",
      script: "test 9007199254740992 -ne 9007199254740993 && test 9007199254740992 -lt 9007199254740993 && [ -9007199254740993 -lt -9007199254740992 ] && [[ 9007199254740993 -gt 9007199254740992 ]] && printf yes",
      stdout: "yes",
    },
    {
      name: "preserves trailing-slash directory requirements in test and bracket",
      files: { "/plain": "body", "/tree/file": "body" },
      script: "test '!' -e /plain/ && test '!' -f /plain/ && [ '!' -s /plain/ ] && test -e /tree/ && [ -d /tree/ ] && [[ ! -e /plain/ && -d /tree/ ]] && printf yes",
      stdout: "yes",
    },
    {
      name: "uses the last redirection substitution status for an assignment-only command",
      script: `X= > "$(printf first; false)"; printf '%s|' "$?"; X=$(false) > "$(printf second; true)"; printf '%s' "$?"`,
      stdout: "1|0",
      expectedFiles: { "/first": "", "/second": "" },
    },
    {
      name: "expands redirection operands after assignment words regardless of source order",
      script: `> "$(printf target; false)" X=$(true); printf '%s' "$?"`,
      stdout: "1",
      expectedFiles: { "/target": "" },
    },
    {
      name: "creates a file with a redirection-only simple command",
      script: "> /created",
      expectedFiles: { "/created": "" },
    },
    {
      name: "truncates a file with a redirection-only simple command",
      files: { "/target": "old" },
      script: "> /target",
      expectedFiles: { "/target": "" },
    },
    {
      name: "opens append output with a redirection-only simple command",
      files: { "/target": "kept" },
      script: ">> /target; >> /created",
      expectedFiles: { "/target": "kept", "/created": "" },
    },
    {
      name: "opens input with a redirection-only simple command",
      files: { "/input": "unused" },
      script: `< /input; printf '%s' "$?"`,
      stdout: "0",
    },
    {
      name: "reports a missing input redirection without a command",
      script: "< /missing",
      exitCode: 1,
      stderrIncludes: "no such file or directory",
    },
  ]);
});

describe("Bash v2 control flow and scopes", () => {
  bashCases([
    {
      name: "short-circuits && and || lists",
      script: "false && printf no; true || printf no; false || printf yes",
      stdout: "yes",
    },
    {
      name: "negates a pipeline status with !",
      script: `! false; printf '%s|' "$?"; ! true; printf '%s' "$?"`,
      stdout: "0|1",
    },
    {
      name: "runs brace groups in the current shell scope",
      script: `X=outer; { X=group; }; printf '%s' "$X"`,
      stdout: "group",
    },
    {
      name: "isolates parenthesized subshell state",
      script: `X=outer; (X=inner; printf '%s|' "$X"); printf '%s' "$X"`,
      stdout: "inner|outer",
    },
    {
      name: "selects the first successful if or elif branch",
      script: "if false; then printf no; elif true; then printf elif; else printf no; fi",
      stdout: "elif",
    },
    {
      name: "returns success when an if command selects no branch",
      script: `if false; then printf no; fi; printf '%s' "$?"`,
      stdout: "0",
    },
    {
      name: "re-evaluates while conditions after each body",
      script: "N=0; while ((N < 3)); do printf '%s' \"$N\"; ((N++)); done",
      stdout: "012",
    },
    {
      name: "re-evaluates until conditions after each body",
      script: "N=0; until ((N >= 3)); do ((N++)); printf '%s' \"$N\"; done",
      stdout: "123",
    },
    {
      name: "iterates an explicit for word list after expansion",
      script: `for item in a "b c" d; do printf '<%s>' "$item"; done`,
      stdout: "<a><b c><d>",
    },
    {
      name: "uses positional arguments when for omits in",
      script: `for item; do printf '<%s>' "$item"; done`,
      args: ["one", "two words"],
      stdout: "<one><two words>",
    },
    {
      name: "applies continue and break to the current loop",
      script: "for item in a b c d; do test \"$item\" = b && continue; printf '%s' \"$item\"; test \"$item\" = c && break; done",
      stdout: "ac",
    },
    {
      name: "propagates break levels through nested loops",
      script: "for outer in 1 2; do for inner in a b; do printf '%s%s|' \"$outer\" \"$inner\"; break 2; done; printf no; done; printf done",
      stdout: "1a|done",
    },
    {
      name: "propagates continue levels through nested loops",
      script: "for outer in 1 2; do for inner in a b; do test \"$inner\" = a && continue 2; printf no; done; printf no; done; printf done",
      stdout: "done",
    },
    {
      name: "matches case alternatives in declaration order",
      script: `X=beta; case "$X" in alpha|beta) printf matched ;; *) printf no ;; esac`,
      stdout: "matched",
    },
    {
      name: "supports wildcard and bracket case patterns",
      script: `X=file7; case "$X" in file[0-9]) printf digit ;; file*) printf broad ;; esac`,
      stdout: "digit",
    },
    {
      name: "treats quoted case metacharacters literally",
      script: `X='*'; case "$X" in "*") printf literal ;; *) printf wildcard ;; esac`,
      stdout: "literal",
    },
    {
      name: "matches leading closing brackets and negated bracket classes",
      script: "case ']' in []a]) printf leading;; *) printf no;; esac; case a in [!]]) printf '|negated';; *) printf no;; esac",
      stdout: "leading|negated",
    },
    {
      name: "ignores descending ranges without discarding later class literals",
      script: "case a in [z-a]) printf no;; *) printf descending;; esac; case c in [z-ac]) printf '|tail';; *) printf no;; esac",
      stdout: "descending|tail",
    },
  ]);
});

describe("Bash v2 functions", () => {
  bashCases([
    {
      name: "restores local variables and function positional arguments",
      script: [
        "X=global",
        `show() { local X=local; printf '%s:%s:%s|' "$X" "$1" "$#"; }`,
        "show argument",
        `printf '%s:%s' "$X" "$#"`,
      ],
      args: ["outer"],
      stdout: "local:argument:1|global:1",
    },
    {
      name: "uses an explicit return status",
      script: `stop() { return 7; }; stop || printf '%s' "$?"`,
      stdout: "7",
    },
    {
      name: "wraps signed return and exit statuses to eight bits",
      script: "status() { return \"$1\"; }; status -1; printf '%s|' \"$?\"; status -257; printf '%s|' \"$?\"; status 0; printf '%s|' \"$?\"; status 255; printf '%s|' \"$?\"; status 256; printf '%s|' \"$?\"; (exit -1); printf '%s' \"$?\"",
      stdout: "255|255|0|255|0|255",
    },
    {
      name: "rejects non-numeric signed return and exit statuses",
      script: "status() { return \"$1\"; }; status invalid 2> /return-error; printf '%s|' \"$?\"; (exit invalid) 2> /exit-error; printf '%s' \"$?\"",
      stdout: "2|2",
      expectedFiles: {
        "/return-error": "return status must be an integer\n",
        "/exit-error": "exit status must be an integer\n",
      },
    },
    {
      name: "uses the previous status for a bare return",
      script: `stop() { false; return; }; stop || printf '%s' "$?"`,
      stdout: "1",
    },
    {
      name: "restores nested local frames independently",
      script: [
        "X=global",
        `inner() { local X=inner; printf '%s|' "$X"; }`,
        `outer() { local X=outer; inner; printf '%s|' "$X"; }`,
        "outer",
        `printf '%s' "$X"`,
      ],
      stdout: "inner|outer|global",
    },
    {
      name: "keeps a function defined in a brace group",
      script: `{ speak() { printf yes; }; }; speak`,
      stdout: "yes",
    },
    {
      name: "does not leak a function defined in a subshell",
      script: `(speak() { printf no; }); speak`,
      exitCode: 127,
      stderrIncludes: "speak: command not found",
    },
    {
      name: "rejects local outside a function",
      script: "local X=value",
      exitCode: 2,
      stderrIncludes: "local: can only be used in a function",
    },
    {
      name: "rejects return outside a function",
      script: "return 3",
      exitCode: 2,
      stderrIncludes: "return: can only be used in a function",
    },
    {
      name: "rejects loop control outside a loop",
      script: "break",
      exitCode: 2,
      stderrIncludes: "break: only meaningful in a loop",
    },
  ]);
});

describe("Bash v2 parameter expansion", () => {
  bashCases([
    {
      name: "uses - only when a parameter is unset",
      script: `unset X; EMPTY=; printf '<%s>|<%s>' "\${X-default}" "\${EMPTY-default}"`,
      stdout: "<default>|<>",
    },
    {
      name: "uses :- when a parameter is unset or empty",
      script: `unset X; EMPTY=; printf '<%s>|<%s>' "\${X:-default}" "\${EMPTY:-default}"`,
      stdout: "<default>|<default>",
    },
    {
      name: "uses = only when a parameter is unset",
      script: `unset X; EMPTY=; printf '<%s>|<%s>|' "\${X=assigned}" "\${EMPTY=ignored}"; printf '%s:%s' "$X" "$EMPTY"`,
      stdout: "<assigned>|<>|assigned:",
    },
    {
      name: "uses := when a parameter is unset or empty",
      script: `unset X; EMPTY=; printf '<%s>|<%s>|' "\${X:=one}" "\${EMPTY:=two}"; printf '%s:%s' "$X" "$EMPTY"`,
      stdout: "<one>|<two>|one:two",
    },
    {
      name: "uses + only when a parameter is set",
      script: `unset X; EMPTY=; printf '<%s>|<%s>' "\${X+alternate}" "\${EMPTY+alternate}"`,
      stdout: "<>|<alternate>",
    },
    {
      name: "uses :+ only when a parameter is set and non-empty",
      script: `unset X; EMPTY=; VALUE=x; printf '<%s>|<%s>|<%s>' "\${X:+alternate}" "\${EMPTY:+alternate}" "\${VALUE:+alternate}"`,
      stdout: "<>|<>|<alternate>",
    },
    {
      name: "reports ? for an unset parameter but accepts an empty parameter",
      script: `EMPTY=; printf '<%s>' "\${EMPTY?message}"; printf '%s' "\${MISSING?missing value}"`,
      exitCode: 2,
      stdout: "<>",
      stderrIncludes: "missing value",
    },
    {
      name: "reports :? for an empty parameter",
      script: `EMPTY=; printf '%s' "\${EMPTY:?must not be empty}"`,
      exitCode: 2,
      stderrIncludes: "must not be empty",
    },
    {
      name: "counts Unicode code points in parameter length expansion",
      script: `X='가a'; printf '%s' "\${#X}"`,
      stdout: "2",
    },
    {
      name: "does not evaluate an unused operator word",
      script: `X=set; printf '%s' "\${X:-$(printf bad)}"`,
      stdout: "set",
    },
    {
      name: "evaluates nested parameter operator words lazily",
      script: `unset X Y; printf '%s' "\${X:-\${Y:-deep}}"`,
      stdout: "deep",
    },
    {
      name: "nests parameter expansion inside command substitution inside parameter expansion",
      script: `unset X Y; printf '<%s>' "\${X:-$(printf %s \${Y:-deep})}"`,
      stdout: "<deep>",
    },
    {
      name: "persists assignment performed by := expansion",
      script: `unset X; printf '%s|' "\${X:=value}"; printf '%s' "$X"`,
      stdout: "value|value",
    },
  ]);
});

describe("Bash v3 bounded parameter patterns and substrings", () => {
  bashCases([
    {
      name: "removes the shortest and longest matching prefixes",
      script: "X=abcabc; printf '<%s>|<%s>' \"${X#a*c}\" \"${X##a*c}\"",
      stdout: "<abc>|<>",
    },
    {
      name: "removes the shortest and longest matching suffixes",
      script: "X=abcabc; printf '<%s>|<%s>' \"${X%a*}\" \"${X%%a*}\"",
      stdout: "<abc>|<>",
    },
    {
      name: "leaves values unchanged for missing and empty patterns",
      script: "X=abc; printf '<%s>|<%s>|<%s>' \"${X#z*}\" \"${X#}\" \"${X//}\"",
      stdout: "<abc>|<abc>|<abc>",
    },
    {
      name: "honors quoted and escaped pattern metacharacters",
      script: "X='a*b'; P='a*'; printf '<%s>|<%s>|<%s>' \"${X#'a*'}\" \"${X#a\\*}\" \"${X##$P}\"",
      stdout: "<b>|<b>|<>",
    },
    {
      name: "supports bracket ranges and negated classes without pathname rules",
      script: "X='a/b2'; printf '<%s>|<%s>|<%s>' \"${X#[a-z]}\" \"${X#?[/]}\" \"${X##[!z]*}\"",
      stdout: "</b2>|<b2>|<>",
    },
    {
      name: "expands nested words in removal patterns",
      script: "X=abcabc; PREFIX=a; printf '%s' \"${X##${PREFIX}*}\"",
      stdout: "",
    },
    {
      name: "replaces the first longest match and every non-overlapping match",
      script: "X=abcabc; printf '<%s>|<%s>|<%s>' \"${X/a*c/R}\" \"${X//a?/R}\" \"${X//?/R}\"",
      stdout: "<R>|<RcRc>|<RRRRRR>",
    },
    {
      name: "supports deletion, nested replacement expansion, and no-match replacement",
      script: "X=abcabc; R=Z; printf '<%s>|<%s>|<%s>' \"${X//a}\" \"${X//a/${R:-x}}\" \"${X//z*/R}\"",
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
      script: "X='가나다라마바사'; OFFSET=2; printf '<%s>|<%s>|<%s>|<%s>' \"${X:1}\" \"${X:1:3}\" \"${X: -2}\" \"${X:${OFFSET}:2}\"",
      stdout: "<나다라마바사>|<나다라>|<바사>|<다라>",
    },
    {
      name: "clamps substring offsets and accepts zero length",
      script: "X=abc; printf '<%s>|<%s>|<%s>' \"${X:99}\" \"${X: -99}\" \"${X:1:0}\"",
      stdout: "<>|<abc>|<>",
    },
    {
      name: "treats unset and empty scalar values as empty",
      script: "unset X; EMPTY=; printf '<%s>|<%s>|<%s>' \"${X##*}\" \"${EMPTY//a/b}\" \"${X:0:2}\"",
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
      script: "X=abc; printf '%s' \"${X:0:-1}\" || printf '%s|' \"$?\"; LENGTH=x; printf '%s' \"${X:0:${LENGTH}}\"",
      exitCode: 2,
      stdout: "2|",
      stderrIncludes: ["must not be negative", "must expand to an integer"],
    },
    {
      name: "keeps Version 2 default operators on the at parameter",
      args: ["argument"],
      script: "printf '<%s>|<%s>' \"${@:-fallback}\" \"${@+set}\"",
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
    await expect(splitFields.run(": $X", {
      env: { X: Array.from({ length: 100 }, (_, index) => String(index)).join(" ") },
    })).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("shell expansion field limit exceeded"),
    });

    const bracketWork = createBashHarness({ limits: { maxExpansionWork: 500 } });
    await expect(bracketWork.run(`printf '%s' \"${"${X//["}${"a".repeat(200)}${"]/x}"}\"`, {
      env: { X: "b".repeat(20) },
    })).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("shell expansion work limit exceeded"),
    });

    const substringWork = createBashHarness({ limits: { maxExpansionWork: 100 } });
    await expect(substringWork.run("printf '%s' \"${X:99:1}\"", {
      env: { X: "a".repeat(1_000) },
    })).resolves.toMatchObject({
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
});

describe("Bash v2 arithmetic", () => {
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
    ["applies compound assignment inside comma expressions", "N=1, N<<=3, N", "8"],
  ];

  bashCases(operatorCases.map(([name, expression, output]): BashCase => ({
    name,
    script: `printf '%s' "$(( ${expression} ))"`,
    stdout: output,
  })));

  bashCases([
    { name: "applies multiplication before addition", script: `printf '%s' "$((2 + 3 * 4))"`, stdout: "14" },
    { name: "honors arithmetic parentheses", script: `printf '%s' "$(((2 + 3) * 4))"`, stdout: "20" },
    { name: "accepts hexadecimal literals", script: `printf '%s' "$((0x10 + 1))"`, stdout: "17" },
    {
      name: "interprets leading-zero literals and variable values as octal",
      script: `VALUE=010; printf '%s|%s' "$((010))" "$((VALUE))"`,
      stdout: "8|8",
    },
    { name: "supports logical and bitwise unary operators", script: `printf '%s|%s' "$((!0))" "$((~0))"`, stdout: "1|-1" },
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
    { name: "returns the last comma expression", script: `printf '%s' "$((1, 2, 3))"`, stdout: "3" },
    {
      name: "wraps deterministically at signed 64 bits",
      script: `printf '%s' "$((9223372036854775807 + 1))"`,
      stdout: "-9223372036854775808",
    },
    { name: "reads non-numeric variable text as zero", script: `X=text; printf '%s' "$((X + 2))"`, stdout: "2" },
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
});

describe("Bash v3 nounset", () => {
  bashCases([
    {
      name: "supports both nounset option spellings and disabling forms",
      script: [
        "set -u",
        "set +u",
        "printf '<%s>|' \"$FIRST\"",
        "set -o nounset",
        "set +o nounset",
        "printf '<%s>' \"$SECOND\"",
      ],
      stdout: "<>|<>",
    },
    {
      name: "rejects unsupported set option names as ordinary usage failures",
      script: "set -o unsupported || printf 'status=%s' \"$?\"",
      stdout: "status=2",
      stderrIncludes: "set: unsupported option name: unsupported",
    },
    {
      name: "rejects unsupported combined nounset forms",
      script: "set -uo nounset || printf 'status=%s' \"$?\"",
      stdout: "status=2",
      stderrIncludes: "set: supported forms are",
    },
    {
      name: "terminates the current shell scope on a plain unset scalar",
      script: "set -u; printf before; printf '%s' \"$MISSING\" || printf caught; printf after",
      exitCode: 1,
      stdout: "before",
      stderr: "MISSING: unbound variable\n",
    },
    {
      name: "does not let if conditions suppress nounset",
      script: "set -u; if printf '%s' \"$MISSING\"; then printf yes; else printf no; fi; printf after",
      exitCode: 1,
      stderrIncludes: "MISSING: unbound variable",
    },
    {
      name: "does not let status inversion suppress nounset",
      script: "set -u; ! printf '%s' \"$MISSING\"; printf after",
      exitCode: 1,
      stderrIncludes: "MISSING: unbound variable",
    },
    {
      name: "preserves default and null-sensitive operators under nounset",
      script: [
        "set -u; unset A B; EMPTY=",
        "printf '<%s>|<%s>|<%s>|<%s>' \"${A-default}\" \"${EMPTY-default}\" \"${B:-default}\" \"${EMPTY:-default}\"",
      ],
      stdout: "<default>|<>|<default>|<default>",
    },
    {
      name: "preserves assignment operators under nounset",
      script: [
        "set -u; unset A B; EMPTY=",
        "printf '<%s>|<%s>|<%s>|' \"${A=one}\" \"${B:=two}\" \"${EMPTY=ignored}\"",
        "printf '%s:%s:%s' \"$A\" \"$B\" \"$EMPTY\"",
      ],
      stdout: "<one>|<two>|<>|one:two:",
    },
    {
      name: "preserves alternate-value operators under nounset",
      script: [
        "set -u; unset A; EMPTY=; VALUE=x",
        "printf '<%s>|<%s>|<%s>|<%s>' \"${A+alt}\" \"${EMPTY+alt}\" \"${EMPTY:+alt}\" \"${VALUE:+alt}\"",
      ],
      stdout: "<>|<alt>|<>|<alt>",
    },
    {
      name: "evaluates default words lazily under nounset",
      script: "set -u; VALUE=set; printf '%s' \"${VALUE:-$MISSING}\"",
      stdout: "set",
    },
    {
      name: "makes an explicit error operator terminate the nounset scope",
      script: "set -u; printf '%s' \"${MISSING?custom message}\" || printf caught; printf after",
      exitCode: 1,
      stderrIncludes: "custom message",
    },
    {
      name: "rejects length expansion of an unset scalar",
      script: "set -u; printf '%s' \"${#MISSING}\"; printf after",
      exitCode: 1,
      stderrIncludes: "MISSING: unbound variable",
    },
    {
      name: "rejects pattern and substring operations on an unset scalar",
      script: "set -u; printf '%s' \"${MISSING#x}\"; printf '%s' \"${MISSING:0}\"",
      exitCode: 1,
      stderrIncludes: "MISSING: unbound variable",
    },
    {
      name: "keeps count and empty at expansion valid with no arguments",
      script: "set -u; printf '<%s>|' \"$#\"; printf '<%s>' \"$@\"",
      stdout: "<0>|<>",
    },
    {
      name: "treats braced at as unset while preserving its zero-argument length",
      script: "set -u; printf '<%s>|<%s>|<%s>' \"${#@}\" \"${@-default}\" \"${@+alternate}\"",
      stdout: "<0>|<default>|<>",
    },
    {
      name: "preserves braced at fields and alternate semantics with arguments",
      args: ["one", "two words"],
      script: "set -u; printf '%s|' \"${#@}\"; printf '<%s>' \"${@-default}\"; printf '|<%s>' \"${@+alternate}\"",
      stdout: "2|<one><two words>|<alternate>",
    },
    {
      name: "rejects a missing positional parameter",
      script: "set -u; printf '%s' \"$1\"; printf after",
      exitCode: 1,
      stderrIncludes: "1: unbound variable",
    },
    {
      name: "allows a default for a missing positional parameter",
      script: "set -u; printf '%s' \"${1-fallback}\"",
      stdout: "fallback",
    },
    {
      name: "uses function and sourced-unit argument frames under nounset",
      args: ["outer"],
      files: { "/argument.sh": "printf '%s|' \"$1\"\n" },
      script: "set -u; show() { printf '%s|' \"$1\"; }; show function; source /argument.sh source; printf '%s' \"$1\"",
      stdout: "function|source|outer",
    },
    {
      name: "rejects a missing function positional parameter in the current scope",
      script: "set -u; show() { printf '%s' \"$1\"; }; show || printf caught; printf after",
      exitCode: 1,
      stderrIncludes: "1: unbound variable",
    },
    {
      name: "rejects an unset arithmetic read",
      script: "set -u; printf '%s' \"$((MISSING + 1))\"; printf after",
      exitCode: 1,
      stderrIncludes: "MISSING: unbound variable",
    },
    {
      name: "allows direct arithmetic assignment and skipped branches",
      script: [
        "set -u",
        "((VALUE = 1))",
        "((0 && MISSING)) || :",
        "((1 || MISSING))",
        "printf '%s' \"$VALUE\"",
      ],
      stdout: "1",
    },
    {
      name: "rejects an update that reads an unset arithmetic variable",
      script: "set -u; ((MISSING++)); printf after",
      exitCode: 1,
      stderrIncludes: "MISSING: unbound variable",
    },
    {
      name: "reads a compound assignment target before its right operand",
      script: "set -u; unset LEFT RIGHT; ((LEFT += RIGHT))",
      exitCode: 1,
      stderr: "LEFT: unbound variable\n",
    },
    {
      name: "reports an unset compound target before a right-side arithmetic error",
      script: "set -u; unset LEFT; ((LEFT += 1 / 0))",
      exitCode: 1,
      stderr: "LEFT: unbound variable\n",
    },
    {
      name: "does not expose command-prefix assignments during argv expansion",
      script: "set -u; VALUE=prefix printf '%s' \"$VALUE\"; printf after",
      exitCode: 1,
      stderrIncludes: "VALUE: unbound variable",
    },
    {
      name: "lets consecutive assignment-only words observe earlier assignments",
      script: "set -u; FIRST=one SECOND=$FIRST; printf '%s' \"$SECOND\"",
      stdout: "one",
    },
    {
      name: "propagates nounset enabled by a function in the current session",
      script: "enable() { set -u; }; enable; printf '%s' \"$MISSING\"; printf after",
      exitCode: 1,
      stderrIncludes: "MISSING: unbound variable",
    },
    {
      name: "terminates the current scope for nounset inside a function",
      script: "set -u; fail() { printf '%s' \"$MISSING\"; printf function-after; }; fail || printf caught; printf after",
      exitCode: 1,
      stderrIncludes: "MISSING: unbound variable",
    },
    {
      name: "propagates nounset enabled by a sourced unit",
      files: { "/enable.sh": "set -u\nVALUE=source\n" },
      script: "source /enable.sh; printf '%s|' \"$VALUE\"; printf '%s' \"$MISSING\"",
      exitCode: 1,
      stdout: "source|",
      stderrIncludes: "MISSING: unbound variable",
    },
    {
      name: "terminates the current scope for nounset inside a sourced unit",
      files: { "/fail.sh": "printf '%s' \"$MISSING\"\nprintf source-after\n" },
      script: "set -u; source /fail.sh || printf caught; printf after",
      exitCode: 1,
      stderrIncludes: "MISSING: unbound variable",
    },
    {
      name: "terminates the current scope for nounset inside an ordinary group",
      script: "set -u; { printf '%s' \"$MISSING\"; }; printf after",
      exitCode: 1,
      stderrIncludes: "MISSING: unbound variable",
    },
    {
      name: "contains nounset termination inside a subshell",
      script: "set -u; (printf '%s' \"$MISSING\"); printf 'after:%s' \"$?\"",
      stdout: "after:1",
      stderr: "MISSING: unbound variable\n",
    },
    {
      name: "discards an atomic subshell redirection on nounset termination",
      files: { "/result": "old" },
      script: "set -u; (printf before; printf '%s' \"$MISSING\") > /result || printf caught; cat /result",
      stdout: "caughtold",
      expectedFiles: { "/result": "old" },
      stderrIncludes: "MISSING: unbound variable",
    },
    {
      name: "isolates nounset disabling in a subshell",
      script: "set -u; (set +u; printf '<%s>' \"$MISSING\"); printf '|'; printf '%s' \"$MISSING\"",
      exitCode: 1,
      stdout: "<>|",
      stderrIncludes: "MISSING: unbound variable",
    },
    {
      name: "contains nounset termination in a pipeline stage",
      script: "set -u; printf '%s' \"$MISSING\" | cat; printf 'after:%s' \"$?\"",
      stdout: "after:0",
      stderr: "MISSING: unbound variable\n",
    },
    {
      name: "lets pipefail expose a terminated nounset stage",
      script: "set -u; set -o pipefail; printf '%s' \"$MISSING\" | cat; printf 'after:%s' \"$?\"",
      stdout: "after:1",
      stderrIncludes: "MISSING: unbound variable",
    },
    {
      name: "isolates option changes made by a pipeline stage",
      script: "set -u | cat; printf '<%s>' \"$MISSING\"",
      stdout: "<>",
    },
    {
      name: "contains nounset termination in command substitution",
      script: "set -u; VALUE=$(printf '%s' \"$MISSING\"); printf 'after:%s:<%s>' \"$?\" \"$VALUE\"",
      stdout: "after:1:<>",
      stderr: "MISSING: unbound variable\n",
    },
    {
      name: "isolates nounset disabling in command substitution",
      script: "set -u; VALUE=$(set +u; printf '<%s>' \"$MISSING\"); printf '%s|' \"$VALUE\"; printf '%s' \"$MISSING\"",
      exitCode: 1,
      stdout: "<>|",
      stderrIncludes: "MISSING: unbound variable",
    },
  ]);
});

describe("Bash v4 deterministic errexit", () => {
  bashCases([
    {
      name: "supports both errexit option spellings and disabling forms",
      script: [
        "set -e",
        "set +e",
        "false",
        "printf a",
        "set -o errexit",
        "set +o errexit",
        "false",
        "printf b",
        "set -e",
        "false",
        "printf no",
      ],
      exitCode: 1,
      stdout: "ab",
    },
    {
      name: "rejects unsupported combined option forms without terminating a guarded list",
      script: "set -eu || printf 'caught:%s' \"$?\"; printf after",
      stdout: "caught:2after",
      stderrIncludes: "set: supported forms are",
    },
    {
      name: "suppresses every non-final pipeline in and-or lists",
      script: [
        "set -e",
        "false && printf no",
        "printf a",
        "true || printf no",
        "printf b",
        "false || true",
        "printf c",
        "false || false",
        "printf no",
      ],
      exitCode: 1,
      stdout: "abc",
    },
    {
      name: "suppresses if, elif, while, and until conditions",
      script: [
        "set -e",
        "if false; then printf no; elif false; then printf no; else printf i; fi",
        "while false; do printf no; done",
        "until true; do printf no; done",
        "printf after",
      ],
      stdout: "iafter",
    },
    {
      name: "propagates an if-condition context through a function body",
      script: "set -e; check() { false; printf condition; }; if check; then printf branch; fi; printf after",
      stdout: "conditionbranchafter",
    },
    {
      name: "uses a failed read only to end a while condition",
      script: "set -e; while read -r LINE; do printf no; done; printf after",
      stdout: "after",
    },
    {
      name: "suppresses a status inverted with bang even when the result is nonzero",
      script: "set -e; ! true; printf a; ! false; printf b",
      stdout: "ab",
    },
    {
      name: "terminates through nested functions in an active context",
      script: [
        "set -e",
        "inner() { false; printf inner-after; }",
        "outer() { printf before; inner; printf outer-after; }",
        "outer",
        "printf top-after",
      ],
      exitCode: 1,
      stdout: "before",
    },
    {
      name: "propagates a guarded context through nested function bodies",
      script: [
        "set -e",
        "inner() { false; printf i; }",
        "outer() { inner; false; printf o; }",
        "outer || printf fallback",
        "printf after",
      ],
      stdout: "ioafter",
    },
    {
      name: "propagates active and guarded contexts through brace groups",
      script: [
        "set -e",
        "{ false; printf g; } || printf fallback",
        "printf '|'",
        "{ printf before; false; printf no; }",
        "printf no",
      ],
      exitCode: 1,
      stdout: "g|before",
    },
    {
      name: "does not retrigger a protected failure returned by non-subshell compounds",
      script: [
        "set -e",
        "{ false && true; }",
        "printf g",
        "if true; then false && true; fi",
        "printf i",
        "case x in x) false && true ;; esac",
        "printf c",
        "for item in x; do false && true; done",
        "printf f",
        "N=0",
        "while ((N < 1)); do ((N += 1)); false && true; done",
        "printf w",
      ],
      stdout: "gicfw",
    },
    {
      name: "commits a normally closed compound redirection before errexit",
      files: { "/result": "old" },
      script: "set -e; { printf before; false; printf no; } > /result; printf no",
      exitCode: 1,
      expectedFiles: { "/result": "before" },
    },
    {
      name: "applies errexit independently inside inherited subshell environments",
      script: [
        "set -e",
        "(false; printf s) || printf fallback",
        "printf '|'",
        "(printf before; false; printf no)",
        "printf no",
      ],
      exitCode: 1,
      stdout: "s|before",
    },
    {
      name: "rechecks a protected failure at a subshell boundary",
      script: "set -e; (false && true); printf no",
      exitCode: 1,
    },
    {
      name: "persists disabling errexit from a function in the current shell",
      script: "set -e; disable() { set +e; false; printf d; }; disable; false; printf after",
      stdout: "dafter",
    },
    {
      name: "delays errexit enabled inside a guarded function until the call completes",
      script: "set +e; enable() { set -e; false; printf body; }; enable || printf fallback; printf '|'; false; printf no",
      exitCode: 1,
      stdout: "body|",
    },
    {
      name: "isolates option changes made by a subshell",
      script: "set -e; (set +e; false; printf sub); printf '|'; false; printf no",
      exitCode: 1,
      stdout: "sub|",
    },
    {
      name: "isolates option changes made by a pipeline stage",
      script: "set -e | cat; false; printf after",
      stdout: "after",
    },
    {
      name: "propagates active and guarded contexts through sourced units",
      files: { "/failure.sh": "false\nprintf sourced" },
      script: "set -e; source /failure.sh || printf fallback; printf '|'; source /failure.sh; printf no",
      exitCode: 1,
      stdout: "sourced|",
    },
    {
      name: "rechecks a protected failure at a function boundary",
      script: "set -e; run() { false && true; }; run; printf no",
      exitCode: 1,
    },
    {
      name: "rechecks a protected failure at a source boundary",
      files: { "/protected.sh": "false && true" },
      script: "set -e; source /protected.sh; printf no",
      exitCode: 1,
    },
    {
      name: "persists errexit enabled by a sourced unit",
      files: { "/enable.sh": "set -e" },
      script: "set +e; source /enable.sh; false; printf no",
      exitCode: 1,
    },
    {
      name: "persists errexit disabled by a sourced unit",
      files: { "/disable.sh": "set +e" },
      script: "set -e; source /disable.sh; false; printf after",
      stdout: "after",
    },
    {
      name: "uses the final stage status when pipefail is disabled",
      script: "set -e; false | true; printf after",
      stdout: "after",
    },
    {
      name: "terminates with the rightmost failing pipeline status under pipefail",
      script: "set -e; set -o pipefail; (exit 3) | (exit 7); printf no",
      exitCode: 7,
    },
    {
      name: "suppresses errexit throughout a non-final pipeline function stage",
      script: "set -e; set -o pipefail; run() { false; printf stage; }; run | cat; printf after",
      stdout: "stageafter",
    },
    {
      name: "suppresses a negated pipeline after applying pipefail",
      script: "set -e; set -o pipefail; ! false | true; printf after",
      stdout: "after",
    },
    {
      name: "clears inherited errexit in command substitutions by default",
      script: "set -e; VALUE=$(false; printf value); printf '%s|after' \"$VALUE\"",
      stdout: "value|after",
    },
    {
      name: "contains explicitly enabled command-substitution termination",
      script: "set -e; printf '<%s>|' \"$(set -e; false; printf no)\"; printf after",
      stdout: "<>|after",
    },
    {
      name: "uses a failed substitution as assignment-only command status",
      script: "set -e; VALUE=$(false); printf no",
      exitCode: 1,
    },
    {
      name: "applies errexit to an explicit function return only at the call boundary",
      script: "set -e; fail() { return 7; printf no; }; fail; printf no",
      exitCode: 7,
    },
    {
      name: "lets a guarded caller handle an explicit function return",
      script: "set -e; fail() { return 7; printf no; }; fail || printf 'caught:%s|' \"$?\"; printf after",
      stdout: "caught:7|after",
    },
    {
      name: "preserves explicit exit as whole-scope flow",
      script: "set -e; exit 9; printf no",
      exitCode: 9,
    },
    {
      name: "preserves loop control while guarding its predicate",
      script: "set -e; for item in a b; do test \"$item\" = a && continue; printf b; break; done; printf after",
      stdout: "bafter",
    },
    {
      name: "keeps nounset fatal even in an errexit-suppressed condition",
      script: "set -e; set -u; if printf '%s' \"$MISSING\"; then printf yes; fi; printf no",
      exitCode: 1,
      stderrIncludes: "MISSING: unbound variable",
    },
    {
      name: "lets a guarded list handle a semantic expansion status",
      script: "set -e; ((1 / 0)) || printf caught; printf after",
      stdout: "caughtafter",
      stderrIncludes: "division by zero",
    },
    {
      name: "terminates on an unguarded semantic expansion status",
      script: "set -e; ((1 / 0)); printf no",
      exitCode: 2,
      stderrIncludes: "division by zero",
    },
    {
      name: "treats double-bracket false as an ordinary guarded or active status",
      script: "set -e; [[ x == y ]] || printf caught; [[ x == y ]]; printf no",
      exitCode: 1,
      stdout: "caught",
    },
  ]);
  it("shares command budgets across guarded functions and sourced units", async () => {
    const harness = createBashHarness({ limits: { maxCommands: 8 } });
    await harness.fileSystem.writeFile("/guarded.sh", "false; true");
    await expect(harness.run([
      "set -e",
      "run() { false; true; }",
      "run || :",
      "source /guarded.sh || :",
      "printf no",
    ])).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr: expect.stringContaining("shell command limit exceeded"),
    });
  });
});

describe("Bash v3 bounded double-bracket conditionals", () => {
  bashCases([
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
      script: "cd /tree; [[ -e ./file && -f ../tree/file && -d . && ! -e missing && ! -e '' ]] && printf yes",
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
      script: "if [[ value == v* ]]; then printf yes; else printf no; fi; [[ no == yes ]] || printf ':false'",
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

  const rejectedConditionals: ReadonlyArray<readonly [string, string, string]> = [
    ["regex matching", "[[ x =~ x ]]", "unsupported [[ operator =~"],
    ["single-equals matching", "[[ x = x ]]", "unsupported [[ operator ="],
    ["unsupported metadata predicates", "[[ -s /side ]]", "unsupported [[ unary operator -s"],
    ["timestamp comparisons", "[[ /left -nt /right ]]", "unsupported [[ operator -nt"],
    ["a missing expression", "[[ ]]", "[[ expression is missing"],
    ["a missing unary operand", "[[ -n ]]", "[[ operand for -n is missing"],
    ["a missing binary operand", "[[ x == ]]", "[[ right operand for == is missing"],
    ["a dangling boolean operator", "[[ x && ]]", "[[ expression is missing"],
    ["an unmatched conditional group", "[[ ( x ]]", "[[ expected )"],
    ["an unexpected operand", "[[ x y ]]", "unsupported [[ operator y"],
    ["an unterminated expression", "[[ x == x", "unterminated [["],
  ];

  bashCases(rejectedConditionals.map(([name, syntax, diagnostic]): BashCase => ({
    name: `rejects ${name} before an earlier mutation`,
    script: `printf changed > /side; ${syntax}`,
    exitCode: 2,
    stderrIncludes: diagnostic,
    missingFiles: ["/side"],
  })));

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
    expect(() => fileSystem.stat("/side")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
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
    expect(() => fileSystem.stat("/side")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
  });
});

describe("Bash v2 command substitution", () => {
  bashCases([
    {
      name: "removes every trailing newline from captured output",
      script: `printf '<%s>' "$(printf 'line\n\n')"`,
      stdout: "<line>",
    },
    {
      name: "field-splits unquoted captured output",
      script: `printf '<%s>\n' $(printf 'left right')`,
      stdout: "<left>\n<right>\n",
    },
    {
      name: "isolates variable changes from the parent shell",
      script: `X=outer; printf '%s|' "$(X=inner; printf '%s' "$X")"; printf '%s' "$X"`,
      stdout: "inner|outer",
    },
    {
      name: "inherits and consumes the current virtual stdin",
      script: `printf '<%s>' "$(cat)"`,
      stdin: "input\n",
      stdout: "<input>",
    },
    {
      name: "supports nested substitutions",
      script: `printf '<%s>' "$(printf '%s' "$(printf nested)")"`,
      stdout: "<nested>",
    },
    {
      name: "does not close command substitution at a case pattern delimiter",
      script: `printf '<%s>' "$(case x in x) printf ok ;; esac)"`,
      stdout: "<ok>",
    },
    {
      name: "does not close command substitution in a here-document body",
      script: "printf '<%s>' \"$(cat <<EOF\n)\nEOF\n)\"",
      stdout: "<)>",
    },
    {
      name: "uses substitution status for assignment-only commands",
      script: `VALUE=$(false); printf '%s|' "$?"; VALUE=$(true); printf '%s' "$?"`,
      stdout: "1|0",
    },
    {
      name: "keeps substitution stderr on the current stderr",
      script: `VALUE=$(test 1 -eq invalid); printf '%s' "$?"`,
      exitCode: 0,
      stdout: "2",
      stderrIncludes: "integer expression expected",
    },
    {
      name: "does not leak parameter assignments from a substitution",
      script: `unset X; printf '%s|' "$(printf '%s' "\${X:=inner}")"; printf '<%s>' "$X"`,
      stdout: "inner|<>",
    },
    {
      name: "preserves quoted empty substitution but removes it unquoted",
      script: `printf '<%s>|' "$(true)"; printf '<%s>\n' before $(true) after`,
      stdout: "<>|<before>\n<after>\n",
    },
    {
      name: "applies pathname expansion to unquoted captured output",
      script: `mkdir /g; touch /g/a /g/b; printf '<%s>\n' $(printf '/g/*')`,
      stdout: "</g/a>\n</g/b>\n",
    },
  ]);

  it("rejects invalid UTF-8 captured from a byte command", async () => {
    const invalidUtf8 = defineCommand("invalid-utf8", async (_context, _argv, fds) => {
      await fds[1].write(new Uint8Array([0xff]));
      return 0;
    });
    const harness = createBashHarness({ extraCommands: [invalidUtf8] });
    const result = await harness.run(`printf '%s' "$(invalid-utf8)"`);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("valid UTF-8");
  });

  it("rejects NUL bytes captured from a byte command", async () => {
    const nul = defineCommand("nul", async (_context, _argv, fds) => {
      await fds[1].write(new Uint8Array([0]));
      return 0;
    });
    const harness = createBashHarness({ extraCommands: [nul] });
    const result = await harness.run(`printf '%s' "$(nul)"`);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("NUL byte");
  });
});

describe("Bash v2 here-documents and here-strings", () => {
  bashCases([
    {
      name: "expands an unquoted here-document body",
      script: "NAME=world\ncat <<EOF\nhello $NAME\nEOF",
      stdout: "hello world\n",
    },
    {
      name: "keeps a single-quoted here-document body literal",
      script: "NAME=world\ncat <<'EOF'\nhello $NAME\nEOF",
      stdout: "hello $NAME\n",
    },
    {
      name: "disables expansion when any delimiter character is quoted",
      script: "NAME=world\ncat <<E\"OF\"\nhello $NAME\nEOF",
      stdout: "hello $NAME\n",
    },
    {
      name: "strips leading tabs with <<- from bodies and delimiters",
      script: "cat <<-EOF\n\tone\n\t\ttwo\n\tEOF",
      stdout: "one\ntwo\n",
    },
    {
      name: "lets the last of multiple input redirections win",
      script: "cat <<FIRST <<SECOND\nignored\nFIRST\nkept\nSECOND",
      stdout: "kept\n",
    },
    {
      name: "appends exactly one newline to a here-string",
      script: `cat <<< "value"`,
      stdout: "value\n",
    },
    {
      name: "supports an empty here-document body",
      script: "cat <<EOF\nEOF\nprintf done",
      stdout: "done",
    },
    {
      name: "expands command and arithmetic expressions in a here-document",
      script: "N=3\ncat <<EOF\n$(printf command):$((N + 1))\nEOF",
      stdout: "command:4\n",
    },
    {
      name: "applies here-document backslash rules without parsing quotes",
      script: "NAME=world\ncat <<EOF\n\"quoted\" 'text' \\x \\$NAME\nEOF",
      stdout: "\"quoted\" 'text' \\x $NAME\n",
    },
    {
      name: "redirects a compound command from a here-document",
      script: "if true; then cat; fi <<EOF\ncompound\nEOF",
      stdout: "compound\n",
    },
    {
      name: "publishes redirected here-document bytes atomically",
      script: "cat <<EOF > /document\nbody\nEOF\ncat /document",
      stdout: "body\n",
      expectedFiles: { "/document": "body\n" },
    },
  ]);
});

describe("Bash v3 sourced units", () => {
  bashCases([
    {
      name: "executes a sourced unit in the current variable, function, and cwd scope",
      files: {
        "/lib/setup.sh": "X=sourced; cd /work; speak() { printf function; }",
        "/work/.keep": "",
      },
      script: `X=outer; source /lib/setup.sh; printf '%s:%s|' "$X" "$PWD"; speak`,
      stdout: "sourced:/work|function",
    },
    {
      name: "temporarily replaces positional arguments supplied to source",
      files: { "/args.sh": `printf '<%s:%s:%s>' "$1" "$2" "$#"` },
      script: `source /args.sh one "two words"; printf '|%s:%s' "$1" "$#"`,
      args: ["outer"],
      stdout: "<one:two words:2>|outer:1",
    },
    {
      name: "inherits caller positional arguments when source receives none",
      files: { "/args.sh": `printf '<%s:%s>' "$1" "$#"` },
      script: ". /args.sh",
      args: ["inherited"],
      stdout: "<inherited:1>",
    },
    {
      name: "returns from only the sourced unit with the requested status",
      files: { "/return.sh": "printf before; return 7; printf no" },
      script: `. /return.sh || printf ':%s' "$?"; printf after`,
      stdout: "before:7after",
    },
    {
      name: "preserves whole-shell exit from a sourced unit",
      files: { "/exit.sh": "printf before; exit 9; printf no" },
      script: "source /exit.sh; printf no",
      exitCode: 9,
      stdout: "before",
    },
    {
      name: "parses a complete sourced unit before mutating from that unit",
      files: { "/broken.sh": "printf changed > /side; if true; then :" },
      script: "source /broken.sh",
      exitCode: 2,
      stderrIncludes: ["/broken.sh", "expected fi"],
      missingFiles: ["/side"],
    },
    {
      name: "resolves a bare source path only relative to cwd without PATH search",
      files: { "/bin/library": "printf no", "/work/.keep": "" },
      cwd: "/work",
      script: "source library",
      exitCode: 1,
      stderrIncludes: "/work/library",
    },
    {
      name: "reports missing and directory source operands as shell failures",
      files: { "/directory/entry": "" },
      script: "source /missing || . /directory",
      exitCode: 1,
      stderrIncludes: ["/missing", "/directory"],
    },
    {
      name: "rejects invalid UTF-8 source content",
      files: { "/invalid.sh": new Uint8Array([0xff]) },
      script: "source /invalid.sh",
      exitCode: 1,
      stderrIncludes: ["/invalid.sh", "valid UTF-8"],
    },
    {
      name: "rejects NUL in source content",
      files: { "/nul.sh": new Uint8Array([0x70, 0x72, 0x69, 0x6e, 0x74, 0x66, 0, 0x78]) },
      script: "source /nul.sh",
      exitCode: 2,
      stderrIncludes: ["/nul.sh", "NUL byte"],
    },
  ]);

  it("shares source nesting, total bytes, and AST nodes across sourced units", async () => {
    const nested = createBashHarness({
      limits: {
        maxSourceDepth: 2,
        maxTotalSourceBytes: 1024,
        maxAstNodes: 100,
      },
    });
    await nested.fileSystem.writeFile("/recursive.sh", "source /recursive.sh");
    await expect(nested.run("source /recursive.sh")).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("/recursive.sh: shell source nesting limit exceeded"),
    });

    const mutuallyRecursive = createBashHarness({
      limits: {
        maxSourceDepth: 2,
        maxTotalSourceBytes: 1024,
        maxAstNodes: 100,
      },
    });
    await mutuallyRecursive.fileSystem.writeFile("/a.sh", "source /b.sh");
    await mutuallyRecursive.fileSystem.writeFile("/b.sh", "source /a.sh");
    await expect(mutuallyRecursive.run("source /a.sh")).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("/a.sh: shell source nesting limit exceeded"),
    });

    const sourceBytes = createBashHarness({ limits: { maxTotalSourceBytes: 36 } });
    await sourceBytes.fileSystem.writeFile("/one.sh", "true");
    await sourceBytes.fileSystem.writeFile("/two.sh", "true");
    await expect(sourceBytes.run("source /one.sh; source /two.sh")).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("/two.sh: shell total source byte limit exceeded"),
    });

    const astNodes = createBashHarness({ limits: { maxAstNodes: 12 } });
    await astNodes.fileSystem.writeFile("/one.sh", "true");
    await astNodes.fileSystem.writeFile("/two.sh", "true");
    await expect(astNodes.run("source /one.sh; source /two.sh")).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("/two.sh: shell AST node limit exceeded"),
    });

    const failedAstNodes = createBashHarness({ limits: { maxAstNodes: 35 } });
    await failedAstNodes.fileSystem.writeFile("/bad.sh", "true; true; true; if true; then :");
    await expect(failedAstNodes.run("source /bad.sh || source /bad.sh")).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("/bad.sh: shell AST node limit exceeded"),
    });
  });
});

describe("Bash v3 input and positional built-ins", () => {
  bashCases([
    {
      name: "reads consecutive records without losing a shared input chunk",
      script: "read -r FIRST; read -r SECOND; printf '<%s>|<%s>' \"$FIRST\" \"$SECOND\"",
      stdin: "first line\nsecond line\n",
      stdout: "<first line>|<second line>",
    },
    {
      name: "assigns fixed whitespace fields and preserves the final remainder",
      script: "read -r FIRST SECOND THIRD FOURTH; printf '<%s>|<%s>|<%s>|<%s>' \"$FIRST\" \"$SECOND\" \"$THIRD\" \"$FOURTH\"",
      stdin: "  alpha   beta gamma   \n",
      stdout: "<alpha>|<beta>|<gamma>|<>",
    },
    {
      name: "uses REPLY without field splitting when no name is supplied",
      script: "read -r; printf '<%s>' \"$REPLY\"",
      stdin: "  alpha   beta  \n",
      stdout: "<  alpha   beta  >",
    },
    {
      name: "assigns an EOF partial record and returns failure",
      script: "read -r VALUE || printf '%s:<%s>' \"$?\" \"$VALUE\"",
      stdin: "partial",
      stdout: "1:<partial>",
    },
    {
      name: "clears named variables when EOF arrives before any bytes",
      script: "VALUE=old; read -r VALUE || printf '%s:<%s>' \"$?\" \"$VALUE\"",
      stdout: "1:<>",
    },
    {
      name: "supports the explicit end-of-options marker for read names",
      script: "read -r -- VALUE; printf '%s' \"$VALUE\"",
      stdin: "value\n",
      stdout: "value",
    },
    {
      name: "rejects unsupported read options before consuming input",
      script: "read -p prompt VALUE || read -r VALUE; printf '<%s>' \"$VALUE\"",
      stdin: "kept\n",
      exitCode: 0,
      stdout: "<kept>",
      stderrIncludes: "only read -r",
    },
    {
      name: "keeps read assignments inside a pipeline stage",
      script: "VALUE=outer; printf 'inner\\n' | read -r VALUE; printf '%s' \"$VALUE\"",
      stdout: "outer",
    },
    {
      name: "lets multiple reads in a pipeline group share the stage input",
      script: "printf 'one\\ntwo\\n' | { read -r A; read -r B; printf '%s:%s' \"$A\" \"$B\"; }",
      stdout: "one:two",
    },
    {
      name: "makes the unread suffix available to a following streaming command",
      script: "read -r FIRST; printf '%s|' \"$FIRST\"; cat",
      stdin: "one\ntwo\nthree\n",
      stdout: "one|two\nthree\n",
    },
    {
      name: "shifts root positional parameters by the default and explicit counts",
      script: "shift; printf '%s:%s|' \"$1\" \"$#\"; shift 2; printf '%s:%s' \"$1\" \"$#\"",
      args: ["one", "two", "three", "four"],
      stdout: "two:3|four:1",
    },
    {
      name: "leaves positional parameters unchanged after an excessive shift",
      script: "shift 3 || printf '%s|' \"$?\"; printf '%s:%s' \"$1\" \"$#\"",
      args: ["one", "two"],
      stdout: "1|one:2",
    },
    {
      name: "rejects invalid shifts without partially mutating arguments",
      script: "shift invalid || printf '%s|' \"$?\"; printf '%s:%s' \"$1\" \"$#\"",
      args: ["one", "two"],
      stdout: "2|one:2",
      stderrIncludes: "shift count must be an integer",
    },
    {
      name: "isolates function arguments while allowing shifts in the function frame",
      script: "consume() { shift; printf '%s:%s|' \"$1\" \"$#\"; }; consume inner next; printf '%s:%s' \"$1\" \"$#\"",
      args: ["outer"],
      stdout: "next:1|outer:1",
    },
    {
      name: "restores supplied source arguments after a sourced shift",
      files: { "/shift.sh": "shift; printf '%s:%s|' \"$1\" \"$#\"" },
      script: "source /shift.sh inner next; printf '%s:%s' \"$1\" \"$#\"",
      args: ["outer"],
      stdout: "next:1|outer:1",
    },
    {
      name: "persists a sourced shift when the source inherits caller arguments",
      files: { "/shift.sh": "shift" },
      script: "source /shift.sh; printf '%s:%s' \"$1\" \"$#\"",
      args: ["one", "two"],
      stdout: "two:1",
    },
    {
      name: "isolates shifts in subshells and command substitutions",
      script: "(shift; printf '%s|' \"$1\"); printf '%s|' \"$(shift; printf '%s' \"$1\")\"; printf '%s' \"$1\"",
      args: ["one", "two"],
      stdout: "two|two|one",
    },
  ]);

  it("decodes UTF-8 split across chunks and retains the following record", async () => {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xe2]));
        controller.enqueue(new Uint8Array([0x82, 0xac, 0x20]));
        controller.enqueue(new TextEncoder().encode("value\nnext\n"));
        controller.close();
      },
    });
    const result = await createBashHarness().run(
      "read -r FIRST; read -r SECOND; printf '<%s>|<%s>' \"$FIRST\" \"$SECOND\"",
      { stdin: input },
    );
    expect(result).toEqual({ exitCode: 0, stdout: "<€ value>|<next>", stderr: "" });
  });

  it("rejects invalid UTF-8 and overlong input records", async () => {
    const invalid = await createBashHarness().run("read -r VALUE", {
      stdin: new Uint8Array([0xff, 0x0a]),
    });
    expect(invalid).toMatchObject({ exitCode: 1, stdout: "" });
    expect(invalid.stderr).toContain("read: input is not valid UTF-8");

    const bounded = createBashHarness({ limits: { maxLineBytes: 4 } });
    await expect(bounded.run("read -r VALUE", { stdin: "four\n" })).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr: expect.stringContaining("read: line byte limit exceeded"),
    });

    const buffered = createBashHarness({ limits: { maxBufferedBytes: 4 } });
    await expect(buffered.run("read -r VALUE", { stdin: "a\n12345" })).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr: expect.stringContaining("shell buffered-byte limit exceeded"),
    });
  });

  it("cancels an in-flight read with the shared execution signal", async () => {
    let cancelled = false;
    const input = new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    });
    const controller = new AbortController();
    const execution = createBashHarness().run("read -r VALUE", {
      stdin: input,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(execution).resolves.toMatchObject({ exitCode: 1, stdout: "", stderr: "" });
    expect(cancelled).toBe(true);
  });

  it("releases an unread suffix and cancels its producer when execution aborts", async () => {
    let waiting: (() => void) | undefined;
    const commandStarted = new Promise<void>((resolve) => { waiting = resolve; });
    const waitForAbort = defineCommand("wait-for-abort", (context) =>
      new Promise<number>((_resolve, reject) => {
        waiting?.();
        const abort = (): void => reject(context.signal.reason);
        if (context.signal.aborted) abort();
        else context.signal.addEventListener("abort", abort, { once: true });
      }));
    let cancelled = false;
    const input = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("first\nsecond\n")); },
      cancel() { cancelled = true; },
    });
    const controller = new AbortController();
    const execution = createBashHarness({ extraCommands: [waitForAbort] }).run(
      "read -r FIRST; wait-for-abort",
      { stdin: input, signal: controller.signal },
    );
    await commandStarted;
    controller.abort();
    await expect(execution).resolves.toMatchObject({ exitCode: 1, stdout: "", stderr: "" });
    expect(cancelled).toBe(true);
  });
});

describe("Bash v3 getopts", () => {
  bashCases([
    {
      name: "scans clustered flags and attached or separate option arguments",
      script: "while getopts 'abcd:' OPT; do printf '%s:<%s>:%s|' \"$OPT\" \"$OPTARG\" \"$OPTIND\"; done; printf 'end:%s:%s' \"$OPT\" \"$OPTIND\"",
      args: ["-abc", "-dvalue", "tail"],
      stdout: "a:<>:1|b:<>:1|c:<>:2|d:<value>:3|end:?:3",
    },
    {
      name: "consumes a separate required argument and stops at double dash",
      script: "while getopts 'ab:' OPT; do printf '%s:<%s>|' \"$OPT\" \"$OPTARG\"; done; printf '%s' \"$OPTIND\"",
      args: ["-a", "-b", "value", "--", "tail"],
      stdout: "a:<>|b:<value>|5",
    },
    {
      name: "uses leading-colon silent results for unknown and missing arguments",
      script: "while getopts ':ab:' OPT; do printf '%s:<%s>:%s|' \"$OPT\" \"$OPTARG\" \"$OPTIND\"; done",
      args: ["-x", "-b"],
      stdout: "?:<x>:2|::<b>:3|",
    },
    {
      name: "emits deterministic diagnostics in normal mode",
      script: "getopts 'ab:' OPT; printf '%s:<%s>:%s' \"$OPT\" \"$OPTARG\" \"$OPTIND\"",
      args: ["-x"],
      stdout: "?:<>:2",
      stderr: "getopts: illegal option -- x\n",
    },
    {
      name: "rescans after OPTIND is reset to one",
      script: "while getopts 'ab:' OPT; do printf '%s%s|' \"$OPT\" \"$OPTARG\"; done; OPTIND=1; while getopts 'ab:' OPT; do printf '%s%s|' \"$OPT\" \"$OPTARG\"; done",
      args: ["-a", "-b", "value"],
      stdout: "a|bvalue|a|bvalue|",
    },
    {
      name: "resets a cluster when OPTIND is reassigned to its current value",
      script: "getopts abc OPT; printf '%s|' \"$OPT\"; OPTIND=1; getopts abc OPT; printf '%s' \"$OPT\"",
      args: ["-abc"],
      stdout: "a|a",
    },
    {
      name: "carries the hidden cluster cursor across explicit argument vectors",
      script: "getopts abc OPT -abc; printf '%s|' \"$OPT\"; getopts xyz OPT -xyz; printf '%s' \"$OPT\"",
      stdout: "a|y",
    },
    {
      name: "scans an explicit argument vector without replacing shell positionals",
      script: "while getopts 'ab:' OPT -a -b explicit tail; do printf '%s:%s|' \"$OPT\" \"$OPTARG\"; done; printf '%s:%s' \"$1\" \"$#\"",
      args: ["outer"],
      stdout: "a:|b:explicit|outer:1",
    },
    {
      name: "uses function positional arguments and restores a local OPTIND",
      script: "parse() { local OPTIND=1; while getopts 'ab:' OPT; do printf '%s:%s|' \"$OPT\" \"$OPTARG\"; done; shift \"$((OPTIND - 1))\"; printf 'tail:%s|' \"$1\"; }; parse -a -b value tail; printf 'outer:%s:%s' \"$1\" \"$OPTIND\"",
      args: ["caller"],
      stdout: "a:|b:value|tail:tail|outer:caller:1",
    },
    {
      name: "resets repeated function scans with local OPTIND",
      script: "parse() { local OPTIND=1; getopts abc OPT; printf '%s|' \"$OPT\"; }; parse -abc; parse -abc",
      stdout: "a|a|",
    },
    {
      name: "restores an outer cluster cursor after a local OPTIND frame",
      script: "getopts abc OPT; printf 'outer:%s|' \"$OPT\"; parse() { local OPTIND=1; getopts abc OPT -abc; printf 'inner:%s|' \"$OPT\"; }; parse; getopts abc OPT; printf 'outer:%s' \"$OPT\"",
      args: ["-abc"],
      stdout: "outer:a|inner:a|outer:b",
    },
    {
      name: "runs getopts against supplied source arguments in the current session",
      files: { "/opts.sh": "getopts a OPT; printf 'source:%s:%s|' \"$OPT\" \"$OPTIND\"" },
      script: "source /opts.sh -a; printf 'outer:%s:%s' \"$1\" \"$OPTIND\"",
      args: ["caller"],
      stdout: "source:a:2|outer:caller:2",
    },
    {
      name: "isolates getopts variables and cursor in command substitution",
      script: "printf '%s|' \"$(getopts a OPT; printf '%s:%s' \"$OPT\" \"$OPTIND\")\"; printf '%s:%s' \"$OPT\" \"$OPTIND\"",
      args: ["-a"],
      stdout: "a:2|:1",
    },
    {
      name: "isolates getopts state changes in subshells and pipelines",
      script: "(getopts a OPT; printf '%s:%s|' \"$OPT\" \"$OPTIND\"); printf x | getopts a OPT; printf '%s:%s' \"$OPT\" \"$OPTIND\"",
      args: ["-a"],
      stdout: "a:2|:1",
    },
    {
      name: "rejects malformed getopts invocations deterministically",
      script: "getopts 'a::' OPT || printf '%s|' \"$?\"; getopts a 1BAD || printf '%s' \"$?\"",
      stdout: "2|2",
      stderrIncludes: ["invalid option specification", "invalid variable name"],
    },
    {
      name: "treats colon as an unknown option rather than a specification marker",
      script: "getopts ':a:' OPT; printf '%s:<%s>' \"$OPT\" \"$OPTARG\"",
      args: ["-:"],
      stdout: "?:<:>",
    },
  ]);
});

const rejectedSyntax: ReadonlyArray<readonly [name: string, syntax: string, diagnostic: string]> = [
  ["backtick substitution", "printf `printf x`", "backtick command substitution"],
  ["process substitution", "cat <(printf x)", "redirection requires a word"],
  ["array assignment", "A[0]=x", "array"],
  ["brace expansion", "printf {a,b}", "brace expansion"],
  ["background job", "printf no & printf background", "expected command separator"],
  ["arbitrary descriptor", "printf x 3>/other", "arbitrary file descriptors"],
  ["select loop", "select X in a; do :; done", "reserved syntax select"],
  ["function keyword", "function f { :; }", "reserved syntax function"],
  ["C-style for loop", "for ((N=0; N<1; N++)); do :; done", "unexpected character"],
  ["ANSI-C quoting", "printf $'x'", "ANSI-C quotes"],
  ["unsupported $*", "printf $*", "special parameter"],
  ["unsupported $-", "printf $-", "special parameter"],
  ["unsupported $$", "printf $$", "special parameter"],
];

const malformedCompoundSyntax: ReadonlyArray<readonly [name: string, syntax: string, diagnostic: string]> = [
  ["empty subshell", "()", "non-empty command list"],
  ["empty brace group", "{ }", "non-empty command list"],
  ["empty if condition", "if then printf yes; fi", "non-empty command list"],
  ["empty if body", "if true; then fi", "non-empty command list"],
  ["empty while condition", "while do break; done", "non-empty command list"],
  ["empty while body", "while false; do done", "non-empty command list"],
  ["empty for body", "for item in value; do done", "non-empty command list"],
  ["unterminated brace list", "{ printf ok }", "separator"],
  ["unterminated if condition", "if true then printf yes; fi", "reserved syntax fi"],
  ["unterminated if body", "if true; then true fi", "expected fi"],
  ["unterminated final case body", "case x in x) printf ok esac", "expected esac"],
];

describe("Bash v2 deterministic rejection", () => {
  bashCases(rejectedSyntax.map(([name, syntax, diagnostic]): BashCase => ({
    name: `rejects ${name} before an earlier mutation`,
    script: `printf changed > /side; ${syntax}`,
    exitCode: 2,
    stderrIncludes: diagnostic,
    missingFiles: ["/side"],
  })));

  bashCases(malformedCompoundSyntax.map(([name, syntax, diagnostic]): BashCase => ({
    name: `rejects ${name} before an earlier mutation`,
    script: `printf changed > /side; ${syntax}`,
    exitCode: 2,
    stderrIncludes: diagnostic,
    missingFiles: ["/side"],
  })));

  bashCases([
    {
      name: "rejects an unterminated if before an earlier mutation",
      script: "printf changed > /side; if true; then printf no",
      exitCode: 2,
      stderrIncludes: "expected fi",
      missingFiles: ["/side"],
    },
    {
      name: "rejects an unterminated command substitution before an earlier mutation",
      script: `printf changed > /side; printf "$(printf no"`,
      exitCode: 2,
      stderrIncludes: "unterminated command substitution",
      missingFiles: ["/side"],
    },
    {
      name: "rejects an unterminated parameter expansion before an earlier mutation",
      script: `printf changed > /side; printf "\${X:-no"`,
      exitCode: 2,
      stderrIncludes: "unterminated parameter expansion",
      missingFiles: ["/side"],
    },
    {
      name: "rejects an unterminated arithmetic expression before an earlier mutation",
      script: `printf changed > /side; printf "$((1 + 2)"`,
      exitCode: 2,
      stderrIncludes: "invalid arithmetic expansion",
      missingFiles: ["/side"],
    },
    {
      name: "rejects an unterminated here-document before an earlier mutation",
      script: "printf changed > /side; cat <<EOF\nbody\n",
      exitCode: 2,
      stderrIncludes: "unterminated here-document",
      missingFiles: ["/side"],
    },
    {
      name: "rejects a dangling && before an earlier mutation",
      script: "printf changed > /side; true &&",
      exitCode: 2,
      stderrIncludes: "end of script",
      missingFiles: ["/side"],
    },
    {
      name: "rejects a dangling pipeline before an earlier mutation",
      script: "printf changed > /side; true |",
      exitCode: 2,
      stderrIncludes: "end of script",
      missingFiles: ["/side"],
    },
  ]);

  it("reports syntax offsets in UTF-8 bytes", async () => {
    const harness = createBashHarness();
    const source = `printf 가😀; printf "$((1 + @))"`;
    const expectedOffset = new TextEncoder().encode(source.slice(0, source.indexOf("@"))).byteLength;
    const result = await harness.run(source);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(`at byte ${expectedOffset}`);
  });
});

describe("Bash v2 pathname expansion", () => {
  bashCases([
    {
      name: "sorts bracket glob matches and leaves a no-match glob literal",
      files: { "/g/a1": "", "/g/a2": "", "/g/ab": "" },
      script: "printf '<%s>\\n' /g/a[12] /g/no*",
      stdout: "</g/a1>\n</g/a2>\n</g/no*>\n",
    },
    {
      name: "applies safe Bash bracket semantics to pathname expansion",
      files: { "/a": "", "/z": "", "/c": "", "/]": "" },
      script: "printf '<%s>\\n' /[]a] /[z-a] /[z-ac]",
      stdout: "</]>\n</a>\n</[z-a]>\n</c>\n",
    },
    {
      name: "does not include dotfiles unless the pattern starts with dot",
      files: { "/g/visible": "", "/g/.hidden": "" },
      script: "printf '<%s>\\n' /g/* /g/.*",
      stdout: "</g/visible>\n</g/.hidden>\n",
    },
    {
      name: "preserves quoted glob metacharacters",
      files: { "/g/*x": "literal", "/g/ax": "other" },
      script: "printf '<%s>\\n' /g/\"*\"?",
      stdout: "</g/*x>\n",
    },
    {
      name: "renders relative matches from the current directory",
      files: { "/w/a": "", "/w/sub/.keep": "" },
      script: "cd /w/sub; printf '<%s>\\n' ../*",
      stdout: "<../a>\n<../sub>\n",
    },
    {
      name: "does not give ** recursive semantics",
      files: { "/g/top": "", "/g/deep/nested": "" },
      script: "printf '<%s>\\n' /g/**",
      stdout: "</g/deep>\n</g/top>\n",
    },
  ]);
});

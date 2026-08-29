import { describe } from "vitest";
import { bashCases, bashSuite } from "./helpers/bash.js";

bashSuite("Bash v2 words, assignments, and statuses", [
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
    script:
      "printf '[%d]|[%d]|[%d]|[%d]|[%d]|[%d]|[%d]' 9007199254740993 010 0x10 nope 08 +10 '2#10' 2> /errors; printf '|status=%s' \"$?\"",
    stdout: "[9007199254740993]|[8]|[16]|[0]|[0]|[10]|[2]|status=1",
    expectedFiles: {
      "/errors":
        "printf: nope: invalid number\nprintf: 08: invalid octal number\nprintf: 2#10: invalid number\n",
    },
  },
  {
    name: "formats POSIX characters, integer bases, widths, precisions, and flags",
    script: [
      "printf '<%c>|<%i>|<%u>|<%o>|<%x>|<%X>\\n' alpha -12 -1 10 255 255",
      "printf '<%05d>|<%-5s>|<%.3s>|<%8.4d>\\n' -12 xy abcdef 12",
      "printf '<%+d>|<% d>|<%#o>|<%#x>|<%#X>\\n' 12 12 10 255 255",
      "printf '<%.0d>|<%#.0o>|<%.0x>\\n' 0 0 0",
    ].join("; "),
    stdout: [
      "<a>|<-12>|<18446744073709551615>|<12>|<ff>|<FF>",
      "<-0012>|<xy   >|<abc>|<    0012>",
      "<+12>|< 12>|<012>|<0xff>|<0XFF>",
      "<>|<0>|<>",
      "",
    ].join("\n"),
  },
  {
    name: "consumes dynamic printf widths and precisions in POSIX order",
    script: [
      "printf '<%*s>|<%.*s>|<%*.*d>\\n' 5 x 3 abcdef 8 4 12",
      "printf '<%*s>|<%.*s>\\n' -5 x -1 abc",
      "printf '<%*s>' 3 a -3 b",
    ].join("; "),
    stdout: "<    x>|<abc>|<    0012>\n<x    >|<abc>\n<  a><b  >",
  },
  {
    name: "reports an invalid dynamic printf width after formatting with zero",
    script: "printf '<%*s>' nope x 2> /errors; printf '|%s' \"$?\"",
    stdout: "<x>|1",
    expectedFiles: { "/errors": "printf: nope: invalid number\n" },
  },
  {
    name: "preserves unknown printf format and percent-b escapes",
    script: `printf '\\q|%b' '\\q'`,
    stdout: "\\q|\\q",
  },
  {
    name: "compares large test integers without precision loss",
    script:
      "test 9007199254740992 -ne 9007199254740993 && test 9007199254740992 -lt 9007199254740993 && [ -9007199254740993 -lt -9007199254740992 ] && [[ 9007199254740993 -gt 9007199254740992 ]] && printf yes",
    stdout: "yes",
  },
  {
    name: "preserves trailing-slash directory requirements in test and bracket",
    files: { "/plain": "body", "/tree/file": "body" },
    script:
      "test '!' -e /plain/ && test '!' -f /plain/ && [ '!' -s /plain/ ] && test -e /tree/ && [ -d /tree/ ] && [[ ! -e /plain/ && -d /tree/ ]] && printf yes",
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

bashSuite("Bash v2 control flow and scopes", [
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
    script:
      'for item in a b c d; do test "$item" = b && continue; printf \'%s\' "$item"; test "$item" = c && break; done',
    stdout: "ac",
  },
  {
    name: "propagates break levels through nested loops",
    script:
      'for outer in 1 2; do for inner in a b; do printf \'%s%s|\' "$outer" "$inner"; break 2; done; printf no; done; printf done',
    stdout: "1a|done",
  },
  {
    name: "propagates continue levels through nested loops",
    script:
      'for outer in 1 2; do for inner in a b; do test "$inner" = a && continue 2; printf no; done; printf no; done; printf done',
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
    script:
      "case ']' in []a]) printf leading;; *) printf no;; esac; case a in [!]]) printf '|negated';; *) printf no;; esac",
    stdout: "leading|negated",
  },
  {
    name: "ignores descending ranges without discarding later class literals",
    script:
      "case a in [z-a]) printf no;; *) printf descending;; esac; case c in [z-ac]) printf '|tail';; *) printf no;; esac",
    stdout: "descending|tail",
  },
]);

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
      script:
        'status() { return "$1"; }; status -1; printf \'%s|\' "$?"; status -257; printf \'%s|\' "$?"; status 0; printf \'%s|\' "$?"; status 255; printf \'%s|\' "$?"; status 256; printf \'%s|\' "$?"; (exit -1); printf \'%s\' "$?"',
      stdout: "255|255|0|255|0|255",
    },
    {
      name: "rejects non-numeric signed return and exit statuses",
      script:
        'status() { return "$1"; }; status invalid 2> /return-error; printf \'%s|\' "$?"; (exit invalid) 2> /exit-error; printf \'%s\' "$?"',
      stdout: "2|2",
      expectedFiles: {
        "/return-error": "return: status must be an integer\n",
        "/exit-error": "exit: status must be an integer\n",
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

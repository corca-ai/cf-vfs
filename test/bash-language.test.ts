import { describe, expect, it } from "vitest";
import { defineCommand } from "../src/shell/commands/helpers.js";
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
      name: "persists assignment performed by := expansion",
      script: `unset X; printf '%s|' "\${X:=value}"; printf '%s' "$X"`,
      stdout: "value|value",
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
  ]);
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

const rejectedSyntax: ReadonlyArray<readonly [name: string, syntax: string, diagnostic: string]> = [
  ["backtick substitution", "printf `printf x`", "backtick command substitution"],
  ["process substitution", "cat <(printf x)", "redirection requires a word"],
  ["array assignment", "A[0]=x", "array"],
  ["extended test", "[[ -f /side ]]", "reserved syntax [["],
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

describe("Bash v2 deterministic rejection", () => {
  bashCases(rejectedSyntax.map(([name, syntax, diagnostic]): BashCase => ({
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
    const source = `printf 가; printf "$((1 + @))"`;
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

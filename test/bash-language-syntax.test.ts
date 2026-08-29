import { describe, expect, it } from "vitest";
import { defineTestApplet } from "./helpers/applet.js";
import { type BashCase, bashCases, bashSuite, createBashHarness } from "./helpers/bash.js";

const rejectedSyntax: ReadonlyArray<readonly [name: string, syntax: string, diagnostic: string]> = [
  ["process substitution", "cat <(printf x)", "redirection requires a word"],
  ["array assignment", "A[0]=x", "array"],
  ["background job", "printf no & printf background", "expected command separator"],
  ["arbitrary descriptor", "printf x 3>/other", "arbitrary file descriptors"],
  ["select loop", "select X in a; do :; done", "reserved syntax select"],
  ["function keyword", "function f { :; }", "reserved syntax function"],
  ["C-style for loop", "for ((N=0; N<1; N++)); do :; done", "unexpected character"],
  ["ANSI-C quoting", "printf $'x'", "ANSI-C quotes"],
  ["unsupported $$", "printf $$", "special parameter"],
];

describe("Bash v4 brace expansion and backtick substitution", () => {
  bashCases([
    {
      name: "expands braces before the remaining expansions",
      script: "printf '%s|' pre{a,b}post {1..3} {x,y}{1,2}",
      stdout: "preapost|prebpost|1|2|3|x1|x2|y1|y2|",
    },
    {
      name: "leaves a brace that spells no group alone",
      script: "printf '%s|' {a} {} '{a,b}' \\{c,d\\}",
      stdout: "{a}|{}|{a,b}|{c,d}|",
    },
    {
      name: "does not rescan what an expansion produced",
      script: "V={a,b}; printf '%s|' $V",
      stdout: "{a,b}|",
    },
    {
      name: "bounds a range against the expansion budget",
      script: "printf '%s' {1..2000000000}",
      exitCode: 1,
      stderrIncludes: ["shell expansion work limit exceeded"],
    },
    {
      name: "runs a backtick substitution and keeps its status",
      script: "printf '%s|' `printf x` \"`printf y`\"; `false`; printf '%s' $?",
      stdout: "x|y|1",
    },
    {
      name: "reports an unterminated backtick as incomplete input",
      script: "printf `printf x",
      exitCode: 2,
      stderrIncludes: ["unterminated backtick"],
    },
  ]);
});

describe("Bash v5 scalar ergonomics and redirection", () => {
  bashCases([
    {
      name: "replaces and clears positional parameters with set double dash",
      script:
        'set -e -- alpha \'two words\'; printf \'%s:<%s>:%s|\' "$#" "$*" "$2"; set -u --; printf \'%s:<%s>\' "$#" "$*"',
      args: ["original"],
      stdout: "2:<alpha two words>:two words|0:<>",
    },
    {
      name: "expands star as one quoted field and split unquoted fields",
      script: "printf '<%s>|' \"$*\"; printf '[%s]|' $*; printf '%s' \"${#*}\"",
      args: ["one", "two words", ""],
      stdout: "<one two words >|[one]|[two]|[words]|3",
    },
    {
      name: "resolves a scalar indirect parameter and follows nounset",
      script:
        "value=answer; reference=value; printf '%s|' \"${!reference}\"; set -u; missing=absent; (printf '%s' \"${!missing}\") || printf '%s' $?",
      stdout: "answer|1",
      stderrIncludes: "absent: unbound variable",
    },
    {
      name: "accepts Bash single equals patterns and variable existence tests",
      script:
        "empty=; name=empty; [[ abc = a* ]] && printf match; [[ -v $name ]] && printf ':set'; unset empty; [[ -v $name ]] || printf ':unset'",
      stdout: "match:set:unset",
    },
    {
      name: "plain read removes escapes before fixed-IFS field assignment",
      script: 'read left right; printf \'%s:<%s>\' "$left" "$right"',
      stdin: "a\\ b c\n",
      stdout: "a b:<c>",
    },
    {
      name: "plain read joins a backslash-continued physical line",
      script: "read value; printf '<%s>' \"$value\"",
      stdin: "a\\\nb\n",
      stdout: "<ab>",
    },
    {
      name: "redirects and appends both output descriptors to one atomic target",
      script:
        "{ printf out; printf err >&2; } &>/combined; { printf more; printf error >&2; } &>> /combined; cat /combined",
      stdout: "outerrmoreerror",
      expectedFiles: { "/combined": "outerrmoreerror" },
    },
    {
      name: "scopes positional replacement and applies later redirections left to right",
      script:
        'set -- outer; f() { set -- inner words; printf \'<%s:%s>|\' "$#" "$*"; }; f; printf \'<%s:%s>\' "$#" "$*"; { printf out; printf err >&2; } &>/first 2>/second',
      stdout: "<2:inner words>|<1:outer>",
      expectedFiles: { "/first": "out", "/second": "err" },
    },
  ]);

  bashCases([
    {
      name: "continues to reject locale-translated quotes",
      script: 'printf $"translated"',
      exitCode: 2,
      stderrIncludes: "locale and ANSI-C quotes are not supported",
    },
  ]);

  it("bounds a continued logical read across individually bounded physical lines", async () => {
    const harness = createBashHarness({ limits: { maxLineBytes: 3 } });
    await expect(harness.run("read VALUE", { stdin: "a\\\nb\\\ncd\n" })).resolves.toMatchObject({
      exitCode: 1,
      stderr: "read: logical line byte limit exceeded\n",
    });
  });

  it("removes a final backslash and assigns the partial record before EOF", async () => {
    const harness = createBashHarness();
    await expect(
      harness.run('read VALUE || printf \'%s:<%s>\' "$?" "$VALUE"', { stdin: "a\\" }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: "1:<a>", stderr: "" });
  });
});

const malformedCompoundSyntax: ReadonlyArray<
  readonly [name: string, syntax: string, diagnostic: string]
> = [
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

bashSuite(
  "Bash v2 deterministic rejection of unsupported syntax",
  rejectedSyntax.map(
    ([name, syntax, diagnostic]): BashCase => ({
      name: `rejects ${name} before an earlier mutation`,
      script: `printf changed > /side; ${syntax}`,
      exitCode: 2,
      stderrIncludes: diagnostic,
      missingFiles: ["/side"],
    }),
  ),
);

bashSuite(
  "Bash v2 deterministic rejection of malformed compounds",
  malformedCompoundSyntax.map(
    ([name, syntax, diagnostic]): BashCase => ({
      name: `rejects ${name} before an earlier mutation`,
      script: `printf changed > /side; ${syntax}`,
      exitCode: 2,
      stderrIncludes: diagnostic,
      missingFiles: ["/side"],
    }),
  ),
);

bashSuite("Bash v2 deterministic rejection of unterminated syntax", [
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

describe("Bash v2 deterministic rejection diagnostics", () => {
  it("reports syntax offsets in UTF-8 bytes", async () => {
    const harness = createBashHarness();
    const source = `printf 가😀; printf "$((1 + @))"`;
    const expectedOffset = new TextEncoder().encode(
      source.slice(0, source.indexOf("@")),
    ).byteLength;
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

bashSuite("argument, sequence, encoding, and environment utilities", [
  {
    name: "xargs batches whitespace-separated input into one invocation",
    script: "printf 'a b\\nc\\n' | xargs echo",
    stdout: "a b c\n",
  },
  {
    name: "xargs -n splits input into fixed-size batches",
    script: "printf '1 2 3 4 5\\n' | xargs -n 2 echo",
    stdout: "1 2\n3 4\n5\n",
  },
  {
    name: "xargs appends collected arguments after fixed operands",
    files: { "/one": "first\n", "/two": "second\n" },
    script: "printf '/one\\n/two\\n' | xargs cat",
    stdout: "first\nsecond\n",
  },
  {
    name: "xargs treats input as data rather than shell syntax",
    script: "printf '%s\\n' '$HOME' 'a;rm -rf /' '`id`' | xargs -n 1 echo",
    stdout: "$HOME\na;rm\n-rf\n/\n`id`\n",
  },
  {
    name: "xargs runs once on empty input and -r suppresses that run",
    script: [`printf '' | xargs echo empty`, `printf '' | xargs -r echo skipped`],
    stdout: "empty\n",
  },
  {
    name: "xargs reports a failing invocation as status 123",
    script: "printf '1\\n2\\n' | xargs -n 1 false",
    exitCode: 123,
  },
  {
    name: "xargs propagates command-not-found without running further batches",
    script: "printf '1\\n2\\n' | xargs -n 1 no-such-tool",
    exitCode: 127,
    stderrIncludes: "command not found",
  },
  {
    name: "xargs charges the shared mutation budget through the invoked command",
    script: "printf '/a\\n/b\\n' | xargs -n 1 touch; ls /",
    // The reserved directories — the devices and the applet paths — are in
    // every root listing, because they answer everywhere else.
    stdout: "a\nb\nbin\ndev\nusr\n",
  },
  {
    name: "seq counts from one when given a single operand",
    script: "seq 3",
    stdout: "1\n2\n3\n",
  },
  {
    name: "seq accepts explicit first, increment, and last operands",
    script: "seq 2 3 11",
    stdout: "2\n5\n8\n11\n",
  },
  {
    name: "seq counts down with a negative increment",
    script: "seq 3 -1 1",
    stdout: "3\n2\n1\n",
  },
  {
    name: "seq produces nothing when the range is empty",
    script: "seq 5 3",
    stdout: "",
  },
  {
    name: "seq joins values with an explicit separator and pads equal widths",
    script: "seq -s , -w 8 11",
    stdout: "08,09,10,11\n",
  },
  {
    name: "seq pads negative values after their sign",
    script: "seq -w -10 2 2",
    stdout: "-10\n-08\n-06\n-04\n-02\n000\n002\n",
  },
  {
    name: "seq rejects a zero increment as a usage error",
    script: "seq 1 0 5",
    exitCode: 2,
    stderrIncludes: "INCREMENT must not be zero",
  },
  {
    name: "seq rejects floating point operands rather than approximating them",
    script: "seq 1.5",
    exitCode: 2,
    stderrIncludes: "must be a decimal integer",
  },
  {
    name: "base64 round-trips arbitrary bytes through the shell",
    script: "printf 'hello world' | base64 | base64 -d",
    stdout: "hello world",
  },
  {
    name: "base64 wraps encoded output at the requested width",
    script: "printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' | base64 -w 20",
    stdout:
      "YWFhYWFhYWFhYWFhYWFh\nYWFhYWFhYWFhYWFhYWFh\nYWFhYWFhYWFhYWFhYWFh\nYWFhYWFhYWFhYWFhYWFh\n",
  },
  {
    name: "base64 -w 0 omits both wrapping and the trailing newline",
    files: { "/data": "hi" },
    script: "base64 -w 0 /data",
    stdout: "aGk=",
  },
  {
    name: "base64 -d rejects invalid input instead of guessing",
    script: "printf 'not!base64' | base64 -d",
    exitCode: 2,
    stderrIncludes: "invalid input",
  },
  {
    name: "env prints the session environment in byte order",
    script: "env",
    env: { B: "2", A: "1" },
    stdout: "A=1\nB=2\nIFS= \t\n\nLC_ALL=C\nOPTIND=1\nPWD=/\nTZ=UTC\n",
  },
  {
    name: "env assignments without a command persist in the session",
    script: [`env X=kept`, `printf '%s\\n' "$X"`],
    stdout: "IFS= \t\n\nLC_ALL=C\nOPTIND=1\nPWD=/\nTZ=UTC\nX=kept\nkept\n",
  },
  {
    name: "env rejects options rather than silently ignoring them",
    script: "env -i true",
    exitCode: 2,
    stderrIncludes: "unsupported option -i",
  },
]);

describe("argument, sequence, encoding, and environment utility streams", () => {
  it("splits NUL-separated input under xargs -0 so whitespace stays in one argument", async () => {
    const harness = createBashHarness();
    expect(await harness.run("xargs -0 -n 1 echo", { stdin: "a b\0c d\0" })).toMatchObject({
      exitCode: 0,
      stdout: "a b\nc d\n",
      stderr: "",
    });
  });

  it("runs a command with env-scoped assignments and restores the prior value", async () => {
    const probe = defineTestApplet("probe", async (context, _argv, fds) => {
      await fds[1].write(new TextEncoder().encode(`${context.session.env.get("X") ?? ""}\n`));
      return 0;
    });
    const harness = createBashHarness({ extraCommands: [probe] });
    expect(
      await harness.run([`export X=outer`, `env X=inner probe`, `probe`, `printf '%s\\n' "$X"`]),
    ).toMatchObject({ exitCode: 0, stdout: "inner\nouter\nouter\n", stderr: "" });
  });
});

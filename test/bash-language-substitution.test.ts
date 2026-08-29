import { describe, expect, it } from "vitest";
import { defineTestApplet } from "./helpers/applet.js";
import { bashCases, bashSuite, createBashHarness } from "./helpers/bash.js";

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
    const invalidUtf8 = defineTestApplet("invalid-utf8", async (_context, _argv, fds) => {
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
    const nul = defineTestApplet("nul", async (_context, _argv, fds) => {
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
      script: 'NAME=world\ncat <<E"OF"\nhello $NAME\nEOF',
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

bashSuite("Bash v3 sourced units", [
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

describe("Bash v3 sourced-unit limits", () => {
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

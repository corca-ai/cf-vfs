import { describe, expect, it } from "vitest";
import { defineTestApplet } from "./helpers/applet.js";
import { bashSuite, createBashHarness } from "./helpers/bash.js";

bashSuite("Bash v3 input and positional built-ins", [
  {
    name: "reads consecutive records without losing a shared input chunk",
    script: 'read -r FIRST; read -r SECOND; printf \'<%s>|<%s>\' "$FIRST" "$SECOND"',
    stdin: "first line\nsecond line\n",
    stdout: "<first line>|<second line>",
  },
  {
    name: "assigns fixed whitespace fields and preserves the final remainder",
    script:
      'read -r FIRST SECOND THIRD FOURTH; printf \'<%s>|<%s>|<%s>|<%s>\' "$FIRST" "$SECOND" "$THIRD" "$FOURTH"',
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
    script: 'read -r VALUE || printf \'%s:<%s>\' "$?" "$VALUE"',
    stdin: "partial",
    stdout: "1:<partial>",
  },
  {
    name: "clears named variables when EOF arrives before any bytes",
    script: 'VALUE=old; read -r VALUE || printf \'%s:<%s>\' "$?" "$VALUE"',
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
    stderrIncludes: "unsupported option -p",
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
    script: 'shift; printf \'%s:%s|\' "$1" "$#"; shift 2; printf \'%s:%s\' "$1" "$#"',
    args: ["one", "two", "three", "four"],
    stdout: "two:3|four:1",
  },
  {
    name: "leaves positional parameters unchanged after an excessive shift",
    script: 'shift 3 || printf \'%s|\' "$?"; printf \'%s:%s\' "$1" "$#"',
    args: ["one", "two"],
    stdout: "1|one:2",
  },
  {
    name: "rejects invalid shifts without partially mutating arguments",
    script: 'shift invalid || printf \'%s|\' "$?"; printf \'%s:%s\' "$1" "$#"',
    args: ["one", "two"],
    stdout: "2|one:2",
    stderrIncludes: "shift: count must be an integer",
  },
  {
    name: "isolates function arguments while allowing shifts in the function frame",
    script:
      'consume() { shift; printf \'%s:%s|\' "$1" "$#"; }; consume inner next; printf \'%s:%s\' "$1" "$#"',
    args: ["outer"],
    stdout: "next:1|outer:1",
  },
  {
    name: "restores supplied source arguments after a sourced shift",
    files: { "/shift.sh": 'shift; printf \'%s:%s|\' "$1" "$#"' },
    script: 'source /shift.sh inner next; printf \'%s:%s\' "$1" "$#"',
    args: ["outer"],
    stdout: "next:1|outer:1",
  },
  {
    name: "persists a sourced shift when the source inherits caller arguments",
    files: { "/shift.sh": "shift" },
    script: 'source /shift.sh; printf \'%s:%s\' "$1" "$#"',
    args: ["one", "two"],
    stdout: "two:1",
  },
  {
    name: "isolates shifts in subshells and command substitutions",
    script:
      "(shift; printf '%s|' \"$1\"); printf '%s|' \"$(shift; printf '%s' \"$1\")\"; printf '%s' \"$1\"",
    args: ["one", "two"],
    stdout: "two|two|one",
  },
]);

describe("Bash v3 input streaming", () => {
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
      'read -r FIRST; read -r SECOND; printf \'<%s>|<%s>\' "$FIRST" "$SECOND"',
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
});

describe("Bash v3 input cancellation", () => {
  it("cancels an in-flight read with the shared execution signal", async () => {
    let cancelled = false;
    const reading = Promise.withResolvers<void>();
    const input = new ReadableStream<Uint8Array>({
      pull() {
        reading.resolve();
        return new Promise(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const execution = createBashHarness().run("read -r VALUE", {
      stdin: input,
      signal: controller.signal,
    });
    await reading.promise;
    controller.abort();
    await expect(execution).resolves.toMatchObject({ exitCode: 1, stdout: "", stderr: "" });
    expect(cancelled).toBe(true);
  });

  it("releases an unread suffix and cancels its producer when execution aborts", async () => {
    let waiting: (() => void) | undefined;
    const commandStarted = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const waitForAbort = defineTestApplet(
      "wait-for-abort",
      (context) =>
        new Promise<number>((_resolve, reject) => {
          waiting?.();
          const abort = (): void => reject(context.signal.reason);
          if (context.signal.aborted) abort();
          else context.signal.addEventListener("abort", abort, { once: true });
        }),
    );
    let cancelled = false;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first\nsecond\n"));
      },
      cancel() {
        cancelled = true;
      },
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

bashSuite("Bash v3 getopts", [
  {
    name: "scans clustered flags and attached or separate option arguments",
    script:
      'while getopts \'abcd:\' OPT; do printf \'%s:<%s>:%s|\' "$OPT" "$OPTARG" "$OPTIND"; done; printf \'end:%s:%s\' "$OPT" "$OPTIND"',
    args: ["-abc", "-dvalue", "tail"],
    stdout: "a:<>:1|b:<>:1|c:<>:2|d:<value>:3|end:?:3",
  },
  {
    name: "consumes a separate required argument and stops at double dash",
    script:
      "while getopts 'ab:' OPT; do printf '%s:<%s>|' \"$OPT\" \"$OPTARG\"; done; printf '%s' \"$OPTIND\"",
    args: ["-a", "-b", "value", "--", "tail"],
    stdout: "a:<>|b:<value>|5",
  },
  {
    name: "uses leading-colon silent results for unknown and missing arguments",
    script:
      'while getopts \':ab:\' OPT; do printf \'%s:<%s>:%s|\' "$OPT" "$OPTARG" "$OPTIND"; done',
    args: ["-x", "-b"],
    stdout: "?:<x>:2|::<b>:3|",
  },
  {
    name: "emits deterministic diagnostics in normal mode",
    script: 'getopts \'ab:\' OPT; printf \'%s:<%s>:%s\' "$OPT" "$OPTARG" "$OPTIND"',
    args: ["-x"],
    stdout: "?:<>:2",
    stderr: "getopts: illegal option -- x\n",
  },
  {
    name: "rescans after OPTIND is reset to one",
    script:
      "while getopts 'ab:' OPT; do printf '%s%s|' \"$OPT\" \"$OPTARG\"; done; OPTIND=1; while getopts 'ab:' OPT; do printf '%s%s|' \"$OPT\" \"$OPTARG\"; done",
    args: ["-a", "-b", "value"],
    stdout: "a|bvalue|a|bvalue|",
  },
  {
    name: "resets a cluster when OPTIND is reassigned to its current value",
    script:
      "getopts abc OPT; printf '%s|' \"$OPT\"; OPTIND=1; getopts abc OPT; printf '%s' \"$OPT\"",
    args: ["-abc"],
    stdout: "a|a",
  },
  {
    name: "carries the hidden cluster cursor across explicit argument vectors",
    script:
      "getopts abc OPT -abc; printf '%s|' \"$OPT\"; getopts xyz OPT -xyz; printf '%s' \"$OPT\"",
    stdout: "a|y",
  },
  {
    name: "scans an explicit argument vector without replacing shell positionals",
    script:
      'while getopts \'ab:\' OPT -a -b explicit tail; do printf \'%s:%s|\' "$OPT" "$OPTARG"; done; printf \'%s:%s\' "$1" "$#"',
    args: ["outer"],
    stdout: "a:|b:explicit|outer:1",
  },
  {
    name: "uses function positional arguments and restores a local OPTIND",
    script:
      'parse() { local OPTIND=1; while getopts \'ab:\' OPT; do printf \'%s:%s|\' "$OPT" "$OPTARG"; done; shift "$((OPTIND - 1))"; printf \'tail:%s|\' "$1"; }; parse -a -b value tail; printf \'outer:%s:%s\' "$1" "$OPTIND"',
    args: ["caller"],
    stdout: "a:|b:value|tail:tail|outer:caller:1",
  },
  {
    name: "resets repeated function scans with local OPTIND",
    script:
      "parse() { local OPTIND=1; getopts abc OPT; printf '%s|' \"$OPT\"; }; parse -abc; parse -abc",
    stdout: "a|a|",
  },
  {
    name: "restores an outer cluster cursor after a local OPTIND frame",
    script:
      "getopts abc OPT; printf 'outer:%s|' \"$OPT\"; parse() { local OPTIND=1; getopts abc OPT -abc; printf 'inner:%s|' \"$OPT\"; }; parse; getopts abc OPT; printf 'outer:%s' \"$OPT\"",
    args: ["-abc"],
    stdout: "outer:a|inner:a|outer:b",
  },
  {
    name: "runs getopts against supplied source arguments in the current session",
    files: { "/opts.sh": 'getopts a OPT; printf \'source:%s:%s|\' "$OPT" "$OPTIND"' },
    script: 'source /opts.sh -a; printf \'outer:%s:%s\' "$1" "$OPTIND"',
    args: ["caller"],
    stdout: "source:a:2|outer:caller:2",
  },
  {
    name: "isolates getopts variables and cursor in command substitution",
    script:
      'printf \'%s|\' "$(getopts a OPT; printf \'%s:%s\' "$OPT" "$OPTIND")"; printf \'%s:%s\' "$OPT" "$OPTIND"',
    args: ["-a"],
    stdout: "a:2|:1",
  },
  {
    name: "isolates getopts state changes in subshells and pipelines",
    script:
      '(getopts a OPT; printf \'%s:%s|\' "$OPT" "$OPTIND"); printf x | getopts a OPT; printf \'%s:%s\' "$OPT" "$OPTIND"',
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

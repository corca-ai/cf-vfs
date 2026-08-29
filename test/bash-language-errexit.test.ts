import { describe, expect, it } from "vitest";
import { bashSuite, createBashHarness } from "./helpers/bash.js";

bashSuite("Bash v4 deterministic errexit", [
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
    name: "rejects an unsupported combined form without terminating a guarded list",
    script: "set -ex || printf 'caught:%s' \"$?\"; printf after",
    stdout: "caught:2after",
    stderrIncludes: "set: unsupported option -x",
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
    script:
      "set -e; check() { false; printf condition; }; if check; then printf branch; fi; printf after",
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
    script:
      "set +e; enable() { set -e; false; printf body; }; enable || printf fallback; printf '|'; false; printf no",
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
    script:
      "set -e; source /failure.sh || printf fallback; printf '|'; source /failure.sh; printf no",
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
    script:
      "set -e; fail() { return 7; printf no; }; fail || printf 'caught:%s|' \"$?\"; printf after",
    stdout: "caught:7|after",
  },
  {
    name: "preserves explicit exit as whole-scope flow",
    script: "set -e; exit 9; printf no",
    exitCode: 9,
  },
  {
    name: "preserves loop control while guarding its predicate",
    script:
      'set -e; for item in a b; do test "$item" = a && continue; printf b; break; done; printf after',
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

describe("Bash v4 deterministic errexit budgets", () => {
  it("shares command budgets across guarded functions and sourced units", async () => {
    const harness = createBashHarness({ limits: { maxCommands: 8 } });
    await harness.fileSystem.writeFile("/guarded.sh", "false; true");
    await expect(
      harness.run([
        "set -e",
        "run() { false; true; }",
        "run || :",
        "source /guarded.sh || :",
        "printf no",
      ]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr: expect.stringContaining("shell command limit exceeded"),
    });
  });
});

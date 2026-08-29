import { bashSuite } from "./helpers/bash.js";

bashSuite("Bash v3 nounset", [
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
    name: "accepts a clustered short flag beside a named option",
    script: "set -uo nounset; printf '%s' \"$-\"",
    stdout: "u",
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
    script:
      "set -u; if printf '%s' \"$MISSING\"; then printf yes; else printf no; fi; printf after",
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
      'printf \'<%s>|<%s>|<%s>|<%s>\' "${A-default}" "${EMPTY-default}" "${B:-default}" "${EMPTY:-default}"',
    ],
    stdout: "<default>|<>|<default>|<default>",
  },
  {
    name: "preserves assignment operators under nounset",
    script: [
      "set -u; unset A B; EMPTY=",
      'printf \'<%s>|<%s>|<%s>|\' "${A=one}" "${B:=two}" "${EMPTY=ignored}"',
      'printf \'%s:%s:%s\' "$A" "$B" "$EMPTY"',
    ],
    stdout: "<one>|<two>|<>|one:two:",
  },
  {
    name: "preserves alternate-value operators under nounset",
    script: [
      "set -u; unset A; EMPTY=; VALUE=x",
      'printf \'<%s>|<%s>|<%s>|<%s>\' "${A+alt}" "${EMPTY+alt}" "${EMPTY:+alt}" "${VALUE:+alt}"',
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
    script: 'set -u; printf \'<%s>|<%s>|<%s>\' "${#@}" "${@-default}" "${@+alternate}"',
    stdout: "<0>|<default>|<>",
  },
  {
    name: "preserves braced at fields and alternate semantics with arguments",
    args: ["one", "two words"],
    script:
      "set -u; printf '%s|' \"${#@}\"; printf '<%s>' \"${@-default}\"; printf '|<%s>' \"${@+alternate}\"",
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
    script:
      "set -u; show() { printf '%s|' \"$1\"; }; show function; source /argument.sh source; printf '%s' \"$1\"",
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
    script:
      "set -u; fail() { printf '%s' \"$MISSING\"; printf function-after; }; fail || printf caught; printf after",
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
    script:
      "set -u; (printf before; printf '%s' \"$MISSING\") > /result || printf caught; cat /result",
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
    script: 'set -u; VALUE=$(printf \'%s\' "$MISSING"); printf \'after:%s:<%s>\' "$?" "$VALUE"',
    stdout: "after:1:<>",
    stderr: "MISSING: unbound variable\n",
  },
  {
    name: "isolates nounset disabling in command substitution",
    script:
      "set -u; VALUE=$(set +u; printf '<%s>' \"$MISSING\"); printf '%s|' \"$VALUE\"; printf '%s' \"$MISSING\"",
    exitCode: 1,
    stdout: "<>|",
    stderrIncludes: "MISSING: unbound variable",
  },
]);

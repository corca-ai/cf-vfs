import { describe } from "vitest";
import fixtures from "./fixtures/bash-compat.json" with { type: "json" };
import { type BashCase, bashCases } from "./helpers/bash.js";

const PROFILE_STDOUT_OVERRIDES: Readonly<Record<string, string>> = {
  // The Bash image supplies BusyBox sort, whose numeric unique tie-breaking
  // differs from the separately pinned GNU coreutils utility oracle. The shell
  // profile follows GNU and keeps the first input spelling for an equal key.
  "final-unterminated-record-deduplication": "x\nx\ny\nx\nx\ny\n1\n",
};

describe(`Bash differential fixtures (${fixtures.image}, LC_ALL=${fixtures.locale})`, () => {
  bashCases(
    fixtures.cases.map(
      (fixture): BashCase => ({
        name: fixture.name,
        script: fixture.script,
        env: fixture.env,
        args: fixture.args,
        exitCode: fixture.exitCode,
        stdout: PROFILE_STDOUT_OVERRIDES[fixture.name] ?? fixture.stdout,
        stderr: "stderr" in fixture && typeof fixture.stderr === "string" ? fixture.stderr : "",
      }),
    ),
  );
});

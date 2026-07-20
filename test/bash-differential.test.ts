import { describe } from "vitest";
import fixtures from "./fixtures/bash-v2.json" with { type: "json" };
import { bashCases, type BashCase } from "./helpers/bash.js";

describe(`Bash v2 differential fixtures (${fixtures.image}, LC_ALL=${fixtures.locale})`, () => {
  bashCases(fixtures.cases.map((fixture): BashCase => ({
    name: fixture.name,
    script: fixture.script,
    env: fixture.env,
    args: fixture.args,
    exitCode: fixture.exitCode,
    stdout: fixture.stdout,
  })));
});

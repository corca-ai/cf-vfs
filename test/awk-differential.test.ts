import { describe, expect, it } from "vitest";
import { awkCommand } from "../src/shell/commands/awk.js";
import fixtures from "./fixtures/awk-compat.json" with { type: "json" };
import { createBashHarness } from "./helpers/bash.js";

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

describe(`AWK differential fixtures (${fixtures.version})`, () => {
  it("pins the oracle image by digest", () => {
    expect(fixtures.digest).toMatch(/^busybox@sha256:[0-9a-f]{64}$/u);
  });

  for (const fixture of fixtures.cases) {
    it(fixture.name, async () => {
      const harness = createBashHarness({ commands: [awkCommand] });
      const result = await harness.run(`/bin/awk ${fixture.args.map(quote).join(" ")}`, {
        stdin: fixture.input,
      });

      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(fixture.stdout);
      expect(result.exitCode).toBe(fixture.exitCode);
    });
  }
});

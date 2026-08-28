import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/jq-compat.json" with { type: "json" };
import { createBashHarness } from "./helpers/bash.js";

/**
 * Recorded answers from the pinned `jq`.
 *
 * This is the one language in the shell that has an oracle: `jq` is
 * deterministic and containerized, so the profile is held to what the real
 * thing prints rather than to an argument about what it ought to print. A case
 * that disagrees is either a defect here or a divergence that belongs in the
 * registry — never a fixture edited to match.
 */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

describe(`jq differential fixtures (${fixtures.image})`, () => {
  it("pins the oracle image by digest", () => {
    expect(fixtures.digest).toMatch(/^ghcr\.io\/jqlang\/jq@sha256:[0-9a-f]{64}$/u);
  });

  for (const fixture of fixtures.cases) {
    it(fixture.name, async () => {
      const harness = createBashHarness();
      await harness.fileSystem.writeFile("/input", fixture.input);
      const argv = fixture.args.map(quote).join(" ");
      // The input arrives on standard input, the way the oracle received it.
      const result = await harness.run(`jq ${argv} < /input`);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(fixture.stdout);
      expect(result.exitCode).toBe(fixture.exitCode);
    });
  }

  it("rejects unescaped control characters inside JSON strings", async () => {
    const harness = createBashHarness();
    await harness.fileSystem.writeFile("/input", '"line\nbreak"');

    const result = await harness.run("jq -c . < /input");

    expect(result.exitCode).toBe(5);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unescaped control character");
  });
});

/** One demonstration per declared divergence, as the utility registry requires. */
describe("deliberate divergences", () => {
  const DEMONSTRATIONS: Readonly<Record<string, () => Promise<void>>> = {
    "jq-exponent-literals": async () => {
      const harness = createBashHarness();
      const result = await harness.run(`printf '{"a":1e3,"b":2.50}' | jq -c .`);
      expect(result.exitCode).toBe(0);
      // The value is what jq has; only how it is spelled back differs.
      expect(result.stdout).toBe('{"a":1000,"b":2.50}\n');
    },
    "jq-bindings-precede-the-filter": async () => {
      const harness = createBashHarness();
      const before = await harness.run(`jq -rn --arg who world '"hi " + $who'`);
      expect(before.exitCode).toBe(0);
      expect(before.stdout).toBe("hi world\n");
      const after = await harness.run(`jq -rn '"hi " + $who' --arg who world`);
      expect(after.exitCode).not.toBe(0);
    },
    "jq-profile-refuses-the-rest": async () => {
      const harness = createBashHarness();
      for (const filter of [
        "def f: .; f",
        "reduce .[] as $x (0; .+$x)",
        "try . catch .",
        ".. | numbers",
        '"\\(.a)"',
        "@base64",
        'test("a+")',
      ]) {
        const result = await harness.run(`printf '{}' | jq '${filter}'`);
        expect(result.exitCode, filter).toBe(3);
        expect(result.stdout, filter).toBe("");
      }
    },
  };

  it("demonstrates every declared divergence", () => {
    expect(Object.keys(DEMONSTRATIONS).sort()).toEqual(
      fixtures.divergences.map((divergence) => divergence.id).sort(),
    );
  });

  for (const [id, demonstrate] of Object.entries(DEMONSTRATIONS)) it(id, demonstrate);
});

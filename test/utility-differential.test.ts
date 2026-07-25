import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/utility-compat.json" with { type: "json" };
import { createBashHarness } from "./helpers/bash.js";

const WORKDIR = "/work";

interface UtilityFixture {
  readonly name: string;
  readonly oracle: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly script: string;
  readonly stdout: string;
  readonly exitCode: number;
}

const oracleLabel = (name: string): string => {
  const oracle = fixtures.oracles[name as keyof typeof fixtures.oracles];
  return `${oracle.image} (${Object.values(oracle.versions).join(", ")})`;
};

/**
 * One declarative demonstration per declared divergence. A fixture set only
 * proves what it runs, so every entry in the registry must show the behavior
 * cf-vfs produces where it deliberately differs from the oracle.
 */
const DEMONSTRATIONS: Readonly<Record<string, () => Promise<void>>> = {
  "cut-list-ranges-unsupported": async () => {
    const harness = createBashHarness();
    const result = await harness.run("printf 'abcdef\\n' | cut -c2-4");
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("must be an integer");
  },
  "wc-multi-field-padding": async () => {
    const harness = createBashHarness();
    const result = await harness.run("printf 'one two\\nthree\\n' | wc");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("2 3 14\n");
  },
  "diff-output-format": async () => {
    const harness = createBashHarness();
    await harness.fileSystem.writeFile("/left", "a\n");
    await harness.fileSystem.writeFile("/right", "b\n");
    const result = await harness.run("diff /left /right");
    expect(result.exitCode).toBe(1);
    expect(result.stdout.startsWith("--- /left\n+++ /right\n@@")).toBe(true);
  },
};

describe("deliberate divergences", () => {
  it("demonstrates every declared divergence", () => {
    expect(Object.keys(DEMONSTRATIONS).sort()).toEqual(
      fixtures.divergences.map((divergence) => divergence.id).sort(),
    );
  });

  for (const [id, demonstrate] of Object.entries(DEMONSTRATIONS)) {
    it(id, demonstrate);
  }

  it("declares an identified reason and a documented anchor for each entry", () => {
    const identifiers = new Set<string>();
    for (const divergence of fixtures.divergences) {
      expect(divergence.id).toMatch(/^[a-z0-9-]+$/u);
      expect(identifiers.has(divergence.id), divergence.id).toBe(false);
      identifiers.add(divergence.id);
      expect(divergence.command.length).toBeGreaterThan(0);
      expect(divergence.summary.length).toBeGreaterThan(0);
      expect(divergence.reason.length).toBeGreaterThan(0);
      expect(divergence.oracle in fixtures.oracles, divergence.oracle).toBe(true);
    }
  });

  it("keeps a divergence out of the oracle-compared case set", () => {
    const commands = new Set(fixtures.divergences.map((divergence) => divergence.id));
    for (const fixture of fixtures.cases) {
      expect(commands.has(fixture.name), fixture.name).toBe(false);
    }
  });
});

for (const [name, oracle] of Object.entries(fixtures.oracles)) {
  const cases = (fixtures.cases as readonly UtilityFixture[]).filter(
    (fixture) => fixture.oracle === name,
  );
  describe(`${name} differential fixtures — ${oracleLabel(name)}`, () => {
    it("pins the oracle image by digest", () => {
      expect(oracle.digest).toMatch(/@sha256:[0-9a-f]{64}$/u);
    });

    it("covers at least one case", () => {
      expect(cases.length).toBeGreaterThan(0);
    });

    for (const fixture of cases) {
      it(fixture.name, async () => {
        const harness = createBashHarness();
        harness.fileSystem.mkdir(WORKDIR, true);
        for (const [path, content] of Object.entries(fixture.files ?? {})) {
          await harness.fileSystem.writeFile(`${WORKDIR}/${path}`, content);
        }
        const result = await harness.run(fixture.script, {
          cwd: WORKDIR,
          ...(fixture.stdin === undefined ? {} : { stdin: fixture.stdin }),
        });
        // The oracle produced no diagnostics, so cf-vfs must not either:
        // diagnostic text itself is deliberately outside the profile.
        expect(result.stderr).toBe("");
        expect(result.stdout).toBe(fixture.stdout);
        expect(result.exitCode).toBe(fixture.exitCode);
      });
    }
  });
}

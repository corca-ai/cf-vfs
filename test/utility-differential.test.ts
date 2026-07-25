import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/utility-compat.json" with { type: "json" };
import { createBashHarness } from "./helpers/bash.js";

// Must match `WORKDIR` in scripts/regenerate-utility-fixtures.mjs.
const WORKDIR = "/tmp/work";

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
    expect(result.stderr).toBe("cut: character must be an integer\n");
  },
  "wc-multi-field-padding": async () => {
    const harness = createBashHarness();
    const result = await harness.run("printf 'one two\\nthree\\n' | wc");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("2 3 14\n");
  },
  "regexp-subset-is-declared": async () => {
    const harness = createBashHarness();
    // A GNU extension is refused rather than silently meaning a JavaScript class.
    const supported = await harness.run(String.raw`printf 'a1
' | grep '[[:digit:]]'`);
    expect(supported.stdout).toBe("a1\n");
    for (const pattern of ["\\w", "\\b", "\\1"]) {
      const result = await harness.run(`printf 'a\\n' | grep '${pattern}'`);
      expect(result.exitCode, pattern).toBe(2);
      expect(result.stderr, pattern).toContain("grep:");
    }
  },
  "sed-language-is-a-bounded-subset": async () => {
    const harness = createBashHarness();
    for (const script of ["y/a/b/", "1h", ":top", "a\\text"]) {
      const result = await harness.run(`printf 'x\\n' | sed '${script}'`);
      expect(result.exitCode, script).toBe(2);
      expect(result.stderr, script).toContain("sed:");
    }
  },
  "type-does-not-print-a-function-body": async () => {
    const harness = createBashHarness();
    const result = await harness.run(["greet() { printf 'hi\\n'; }", "type greet"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("greet is a function\n");
  },
  "printenv-reads-one-variable-map": async () => {
    const harness = createBashHarness();
    const result = await harness.run(["LOCAL_ONLY=value", "printenv LOCAL_ONLY"]);
    expect(result.exitCode).toBe(0);
    // A POSIX shell would print nothing and exit 1 for an unexported name.
    expect(result.stdout).toBe("value\n");
  },
  "tilde-is-not-expanded-inside-a-parameter-word": async () => {
    const harness = createBashHarness();
    const result = await harness.run("printf '%s' ${MISSING-~/d}", { env: { HOME: "/home/cf" } });
    expect(result.exitCode).toBe(0);
    // Bash expands the unquoted form to /home/cf/d; the quoted form agrees.
    expect(result.stdout).toBe("~/d");
  },
  "permission-predicates-have-no-user": async () => {
    const harness = createBashHarness({ policy: { writeRoots: ["/allowed"] } });
    await harness.fileSystem.writeFile("/only-owner", "body");
    harness.fileSystem.setMetadata("/only-owner", { mode: 0o100400 });
    // A privileged POSIX account would report this writable; there is no
    // account here, so the answer comes from the bits alone.
    const result = await harness.run("test -w /only-owner || printf 'not-writable'");
    expect(result.stdout).toBe("not-writable");

    await harness.fileSystem.writeFile("/outside-roots", "body");
    harness.fileSystem.setMetadata("/outside-roots", { mode: 0o100644 });
    // The policy refuses the write, but the predicate answers about metadata.
    const metadata = await harness.run("test -w /outside-roots && printf 'bits-say-writable'");
    expect(metadata.stdout).toBe("bits-say-writable");
    expect((await harness.run("printf x > /outside-roots")).exitCode).toBe(126);
  },
  "dollar-dash-reports-only-declared-options": async () => {
    const harness = createBashHarness();
    const result = await harness.run(["set -eu", "printf '%s' \"$-\""]);
    expect(result.exitCode).toBe(0);
    // Bash reports `ehuBc` here: `h`, `B`, and `c` name behavior this runtime
    // does not have.
    expect(result.stdout).toBe("eu");
  },
  "script-child-inherits-the-whole-session": async () => {
    const harness = createBashHarness({ commandResolution: "path" });
    await harness.fileSystem.writeFile(
      "/work/probe.sh",
      "#!/bin/sh\nhelper\nprintf '%s|' \"$UNEXPORTED\"\nfalse\nprintf 'reached'\n",
      { createParents: true },
    );
    harness.fileSystem.setMetadata("/work/probe.sh", { mode: 0o100755 });
    const result = await harness.run(
      [
        "helper() { printf 'parent-function|'; }",
        "UNEXPORTED=seen",
        "set -e",
        "./probe.sh || printf 'stopped'",
      ],
      { cwd: "/work" },
    );
    // Bash would print nothing for the function, an empty value, and reach the
    // end because errexit is not inherited either.
    expect(result.stdout).toBe("parent-function|seen|stopped");
  },
  "script-interpreter-profile-is-bounded": async () => {
    const harness = createBashHarness({ commandResolution: "path" });
    await harness.fileSystem.writeFile("/work/py.sh", "#!/usr/bin/python3\nprint(1)\n", {
      createParents: true,
    });
    harness.fileSystem.setMetadata("/work/py.sh", { mode: 0o100755 });
    const result = await harness.run("./py.sh", { cwd: "/work" });
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toBe("/work/py.sh: unsupported interpreter: /usr/bin/python3\n");
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
        // Fixtures run with the Linux search enabled, because an oracle shell
        // always resolves through PATH.
        const harness = createBashHarness({ commandResolution: "path" });
        harness.fileSystem.mkdir(WORKDIR, true);
        for (const [path, content] of Object.entries(fixture.files ?? {})) {
          await harness.fileSystem.writeFile(`${WORKDIR}/${path}`, content, {
            createParents: true,
          });
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

import { describe, expect, it } from "vitest";
import { awikiCommand } from "../src/shell/commands/awiki.js";
import fixtures from "./fixtures/awiki-compat.json" with { type: "json" };
import { createBashHarness } from "./helpers/bash.js";

// Must match `WORKDIR` in scripts/regenerate-awiki-fixtures.mjs, which records
// the native awiki CLI's output for every step below.
const WORKDIR = "/work";

interface Step {
  readonly step: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly files?: Readonly<Record<string, string>>;
}

async function snapshot(
  harness: ReturnType<typeof createBashHarness>,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const entries = harness.fileSystem.find({ path: WORKDIR, type: "file" });
  for (const entry of entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    files[entry.path.slice(WORKDIR.length + 1)] = await harness.readText(entry.path);
  }
  return files;
}

async function seeded(
  files: Readonly<Record<string, string | undefined>>,
  limits?: { maxBufferedBytes: number },
) {
  const harness = createBashHarness({
    extraCommands: [awikiCommand],
    ...(limits === undefined ? {} : { limits }),
  });
  for (const [path, content] of Object.entries(files)) {
    if (content === undefined) continue;
    await harness.fileSystem.writeFile(`${WORKDIR}/${path}`, content, { createParents: true });
  }
  return harness;
}

async function expectStep(harness: ReturnType<typeof createBashHarness>, expected: Step) {
  const result = await harness.run(`cd ${WORKDIR} && awiki ${expected.step}`);
  expect({ step: expected.step, stdout: result.stdout, stderr: result.stderr }).toEqual({
    step: expected.step,
    stdout: expected.stdout,
    stderr: expected.stderr,
  });
  expect(result.exitCode, expected.step).toBe(expected.exitCode);
  if (expected.files === undefined) return;
  expect(await snapshot(harness), expected.step).toEqual(expected.files);
}

describe(`awiki matches the native awiki ${fixtures.awiki}`, () => {
  expect(fixtures.workdir).toBe(WORKDIR);
  for (const fixture of fixtures.cases) {
    it(fixture.name, async () => {
      const harness = await seeded(fixture.files);
      for (const expected of fixture.results as readonly Step[]) {
        await expectStep(harness, expected);
      }
    });
  }

  it("finds the same near-duplicates when the fingerprint index is partitioned", async () => {
    const fixture = fixtures.cases.find((candidate) => candidate.name === "generated wiki");
    const expected = fixture?.results.find((result) => result.step === "suggest");
    if (fixture === undefined || expected === undefined) throw new Error("missing fixture");
    // A small buffered-bytes budget forces many hash partitions.
    const harness = await seeded(fixture.files, { maxBufferedBytes: 96 * 1024 });
    const result = await harness.run(`cd ${WORKDIR} && awiki suggest`);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(expected.stdout);
  });
});

import { expect, it } from "vitest";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { Shell } from "../src/shell/shell.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

async function sed(script: string, input: string, limits: Record<string, number> = {}) {
  const fileSystem = createTestFileSystem();
  await fileSystem.writeFile("/in", input);
  const shell = new Shell({ fileSystem, commands: defaultShellCommands, limits });
  return await shell.executeText({ cwd: "/", script: `${script}; echo "status $?"` });
}

const line = `${"x".repeat(400)}q\n`;

it.each([
  "sed -n ':a;p;ba' /in > /dev/null",
  "sed -n ':a;s/x/x/;ta' /in",
  "sed -n ':a;/[yz]q/!ba' /in",
  `sed -n '${"p;".repeat(200)}' /in > /dev/null`,
])("charges work that reads nothing new: %s", async (script) => {
  const result = await sed(script, line, { maxExpansionWork: 1000, maxSteps: 100_000 });
  expect(result.stderr).toMatch(/expansion work limit/u);
});

it("leaves loops that read as they go, and edits that echo what they read, to the input", async () => {
  // 18,890 characters against a limit of 5,000 units of work; a global
  // substitution still charges a unit for each of its 2,000 matches.
  const text = Array.from({ length: 2000 }, (_, i) => `line ${i}\n`).join("");
  const limits = { maxExpansionWork: 5000 };
  const joined = await sed("sed ':a;N;$!ba;s/\\n/ /g' /in | wc -c", text, limits);
  expect(joined.stdout).toBe(`${text.length}\nstatus 0\n`);
  const edited = await sed("sed 's/line/LINE/' /in | tail -1", text, limits);
  expect(edited.stdout).toBe("LINE 1999\nstatus 0\n");
  const window = await sed("sed '$!N;/9\\n/P;D' /in | wc -l", text, limits);
  expect(window.stdout).toBe("199\nstatus 0\n");
  // An address and an `s` pattern each scan the window, and a loop that
  // reads takes no step.
  const tight = { maxExpansionWork: 1000, maxSteps: 100 };
  for (const script of [
    "sed '$!N;/9/s/line/LINE/;P;D' /in | md5sum",
    "sed -n '/0$/{n;p}' /in | md5sum",
  ]) {
    const result = await sed(script, text, tight);
    expect(result.stderr).toBe("");
    expect(result).toEqual(await sed(script, text));
  }
});

it("charges a regular-expression loop that reads nothing by its scans alone", async () => {
  // 100 lines with 40 spaces each: about 85,000 units, before as now.
  const spaced = Array.from({ length: 100 }, (_, i) => `${" ".repeat(40)}x${i}\n`).join("");
  const enough = await sed("sed ':a;s/  / /;ta' /in | wc -c", spaced, { maxExpansionWork: 90_000 });
  expect(enough.stdout).toBe(`${spaced.length - 3900}\nstatus 0\n`);
  const short = await sed("sed ':a;s/  / /;ta' /in | wc -c", spaced, { maxExpansionWork: 70_000 });
  expect(short.stderr).toMatch(/expansion work limit/u);
});

it.each([
  // Each pass scans the whole space it builds again.
  "sed ':a;N;/never/!ba' /in | wc -c",
  "sed -n ':a;N;s/x/x/;$!ba;p' /in | wc -c",
  "sed -n 'G;h;/never/p' /in",
  // Finding the first line of a growing space reads all of it.
  "sed -n ':a;N;P;$!ba' /in | wc -c",
  // Regular expressions that never run lend the others no allowance.
  `sed ':a;N;/never/!ba${";s/q//".repeat(300)}' /in | wc -c`,
])("charges scanning a space that grows across records: %s", async (script) => {
  const text = Array.from({ length: 2000 }, (_, i) => `line ${i}\n`).join("");
  const result = await sed(script, text, { maxExpansionWork: 5000 });
  expect(result.stderr).toMatch(/expansion work limit/u);
});

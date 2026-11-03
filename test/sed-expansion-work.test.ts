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
  // Joining stays charged as `N` builds the space, as before: 600 lines fit.
  const text = Array.from({ length: 600 }, (_, i) => `line ${i}\n`).join("");
  const joined = await sed("sed ':a;N;$!ba;s/\\n/ /g' /in | wc -c", text);
  expect(joined.stdout).toBe(`${text.length}\nstatus 0\n`);
  const edited = await sed("sed 's/line/LINE/' /in | tail -1", text, { maxExpansionWork: 1000 });
  expect(edited.stdout).toBe("LINE 599\nstatus 0\n");
  const window = await sed("sed '$!N;P;D' /in | wc -l", text);
  expect(window.stdout).toBe("600\nstatus 0\n");
});

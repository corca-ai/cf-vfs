import { expect, it } from "vitest";
import { awkCommand } from "../src/shell/commands/awk.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { Shell } from "../src/shell/shell.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

async function awk(script: string, input: string, limits: Record<string, number> = {}) {
  const fileSystem = createTestFileSystem();
  await fileSystem.writeFile("/in", input);
  await fileSystem.writeFile("/few", input.split("\n").slice(0, 100).join("\n"));
  await fileSystem.writeFile("/tiny", "a\n".repeat(600));
  const shell = new Shell({
    fileSystem,
    commands: [...defaultShellCommands, awkCommand],
    limits,
  });
  return await shell.executeText({ cwd: "/", script: `${script}; echo "status $?"` });
}

const text = Array.from({ length: 600 }, (_, i) => `line ${i} of the input\n`).join("");

it.each([
  ["awk '{ gsub(/line/, \"LINE\"); print }' /in | tail -1", "LINE 599 of the input\n"],
  ["awk '{ sub(/of/, \"in\") } 1' /in | tail -1", "line 599 in the input\n"],
  ["awk '{ $1 = $1; print }' /in | tail -1", "line 599 of the input\n"],
  ["awk '{ x = $0 \"!\" } END { print x }' /in", "line 599 of the input!\n"],
  ["awk '{ n += gsub(/i/, \"i\") } END { print n }' /in", "1200\n"],
  ["awk '{ print sprintf(\"%s\", $0) }' /in | tail -1", "line 599 of the input\n"],
  ["awk '!seen[$0]++' /in | wc -l", "600\n"],
  ["awk '{ gsub(/line/, \"LINE\") } END { print NR }' /in /in /in", "1800\n"],
  ["cat /in | awk '{ $1 = $1 } END { print $0 }'", "line 599 of the input\n"],
  // A loop that builds nothing is charged per iteration only.
  ["awk '{ for (k = 0; k < 3; k++) s = $0 } END { print NR }' /few", "100\n"],
  // Up to four builds of a record are free.
  ['awk \'{ $3 = ""; $4 = ""; print }\' /in | tail -1', "line 599   input\n"],
  [
    'awk \'{ gsub(/i/, "i"); gsub(/i/, "i"); gsub(/i/, "i"); gsub(/i/, "i") } END { print NR }\' /in',
    "600\n",
  ],
  ["awk '{ s = $0 $0 } END { print length(s) }' /in", "42\n"],
])("lets a few edits of each record run on the input: %s", async (script, out) => {
  // 13,000 characters of input against a limit of 1,000 units of work.
  const result = await awk(script, text, { maxExpansionWork: 1000 });
  expect(result.stdout).toBe(`${out}status 0\n`);
});

it.each([
  // Building beyond four times the record is charged: $0 $0, then $0 $0 $0.
  "awk '{ s = $0 $0 $0 } END { print NR }' /in",
  // Rebuilding a record of a character or two many times is not free.
  "awk '{ $1 = $1; $1 = $1; $1 = $1; $1 = $1; $1 = $1; $1 = $1; $1 = $1; $1 = $1 } END { print NR }' /tiny",
  // Padding fields costs a field each, even with an empty OFS.
  "awk -v OFS= '{ $5000 = \"\" } END { print NR }' /tiny",
  // A fifth build of the same record has no allowance left.
  'awk \'{ gsub(/i/, "i"); gsub(/i/, "i"); gsub(/i/, "i"); gsub(/i/, "i"); gsub(/i/, "i") } END { print NR }\' /in',
  // Text built in a loop, or with nothing read, is charged as before.
  "awk '{ for (k = 0; k < 3; k++) s = $0 $0 } END { print NR }' /few",
  // Assigning $0 reads nothing, so it renews no allowance.
  'awk \'{ $0 = $0; gsub(/i/, "i"); $0 = $0; gsub(/i/, "i"); $0 = $0; gsub(/i/, "i"); $0 = $0; gsub(/i/, "i"); $0 = $0; gsub(/i/, "i") } END { print NR }\' /in',
  // END builds as BEGIN does, with no record's allowance.
  "awk '{ } END { while (n++ < 200) t = $0 $0 }' /in",
  "awk 'BEGIN { s = \"xxxxxxxxxx\"; while (n++ < 200) t = s s s s }'",
  "awk '{ s = s $0 } END { print length(s) }' /in",
])("charges text built beyond what was read: %s", async (script) => {
  const result = await awk(script, text, { maxExpansionWork: 1000 });
  expect(result.stderr).toMatch(/expansion work limit/u);
});

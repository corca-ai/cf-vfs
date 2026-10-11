import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [root, executable = "/opt/homebrew/bin/bash"] = process.argv.slice(2);
const base = pathToFileURL(`${resolve(root)}/`);
const { Shell } = await import(new URL("src/shell/shell.js", base));
const { NodeSqlFileSystem } = await import(new URL("src/testing/node.js", base));
const { defaultShellCommands } = await import(new URL("src/shell/commands/default.js", base));
const cases = [
  "printf '%s|' {1..a} {a..1} {é..ê}",
  "printf '%s|' {1..3..999999999999999999999999999} {a..c..999999999999999999999999999}",
  "printf '<%s>|' {Z..b}; printf '\\n'; printf '<%s>|' {b..Z}",
  "printf '%s|' {03..-1..-2} {a..e..2} {e..a..-2} {1..3..0} pre{a,\"two words\"}post",
];
const fs = new NodeSqlFileSystem();
const shell = new Shell({ fileSystem: fs, commands: defaultShellCommands });
const rows = [];
try {
  for (const script of cases) {
    const stdout = execFileSync(executable, ["--noprofile", "--norc", "-s"], {
      input: `${script}\n`,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      timeout: 5000,
    });
    const actual = await shell.executeText({ script });
    assert.equal(actual.exitCode, 0);
    assert.equal(actual.stderr, "");
    assert.equal(actual.stdout, stdout);
    rows.push({ script, stdout, exitCode: actual.exitCode, stderr: actual.stderr });
  }
} finally {
  fs.close();
}
await writeFile(
  new URL("./oracle.json", import.meta.url),
  JSON.stringify(
    {
      executable,
      version: execFileSync(executable, ["--version"], { encoding: "utf8" }).split("\n")[0],
      locale: "C",
      timezone: "UTC",
      note: "Additional host Bash 5.3.20 evidence; pinned 5.3.3 fixtures were not regenerated (Docker unavailable)",
      rows,
    },
    null,
    2,
  ),
);
console.log(`${rows.length} differential cases matched`);

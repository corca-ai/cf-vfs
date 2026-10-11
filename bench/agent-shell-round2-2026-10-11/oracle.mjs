import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectedFiles, files, scenarios } from "./scenarios.ts";

const directory = await mkdtemp(join(tmpdir(), "cf-vfs-agent-oracle-"));
const translate = (text) =>
  text.replace(
    /\/(?:(?:unicode|prefix)-sort\.txt|dependencies(?:-out)?\.json|package\.json|small\.json|escaped(?:-out)?\.json|source\.ts|records\.txt|task\.sh|next\.(?:ts|json))/gu,
    (path) => directory + path,
  );
const rows = [];
try {
  for (const [path, body] of Object.entries(files))
    await writeFile(directory + path, path === "/task.sh" ? translate(body) : body);
  for (const scenario of scenarios) {
    const result = spawnSync("/opt/homebrew/bin/bash", ["-c", translate(scenario.script)], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:${process.env.PATH}`,
        LC_ALL: "C",
        TZ: "UTC",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    // Native uniq/wc padding is implementation-specific; compare numeric fields.
    assert.equal(
      result.stdout.trim().replace(/ +/gu, " "),
      scenario.stdout.trim().replace(/ +/gu, " "),
    );
    for (const [path, body] of Object.entries(expectedFiles[scenario.name] ?? {}))
      assert.equal(await readFile(directory + path, "utf8"), body, path);
    rows.push({
      name: scenario.name,
      exitCode: result.status,
      stdout: result.stdout,
      verifiedFiles: Object.keys(expectedFiles[scenario.name] ?? {}),
    });
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
await writeFile(
  new URL("oracle.json", import.meta.url),
  JSON.stringify(
    {
      bash: execFileSync("/opt/homebrew/bin/bash", ["--version"], { encoding: "utf8" }).split(
        "\n",
      )[0],
      jq: execFileSync("jq", ["--version"], { encoding: "utf8" }).trim(),
      locale: "C",
      rows,
    },
    null,
    2,
  ),
);
console.log(`${rows.length} agent workflows match host Bash/jq/sed`);

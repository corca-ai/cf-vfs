import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";

const [baselineRoot] = process.argv.slice(2);
assert.ok(baselineRoot);
const commit = execFileSync("git", ["-C", baselineRoot, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
assert.ok(
  commit.startsWith("02f2ef3"),
  "Only the immutable session baseline may receive matching benchmark fixtures",
);
for (const name of [
  "benchmark-suite",
  "benchmark-git-command",
  "benchmark-git-shell",
  "benchmark-git-workflow",
  "benchmark-git-recovery",
  "benchmark-git-checkout-recovery",
])
  await copyFile(resolve(`demo/${name}.ts`), resolve(baselineRoot, `demo/${name}.ts`));
console.log(`Library ${commit}; copied matching optional-clock benchmark fixtures`);

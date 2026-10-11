import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { pairedRatio, pairOrder } from "../comparison.mjs";

const engines = {};
const root = process.argv[2];
for (const version of ["baseline", "equal", "bmp", "points", "hybrid"])
  engines[version] = (
    await import(
      pathToFileURL(
        root
          ? resolve(root, version, "src/core/path.js")
          : `/tmp/cf-vfs-agent2-${version}/src/core/path.js`,
      ).href
    )
  ).compareUtf8;
const cases = [
  ["short-ascii", "module-201", "module-202"],
  ["equal", "alpha", "alpha"],
  ["short-unicode", "module-한글", "module-日本"],
  ["supplementary", "prefix😀", "prefix\ue000"],
  ["long-supplementary-prefix", `${"😀".repeat(4096)}b`, `${"😀".repeat(4096)}c`],
  ["long-prefix", `${"a".repeat(8192)}b`, `${"a".repeat(8192)}c`],
  ["long-different", `b${"a".repeat(8192)}`, `c${"a".repeat(8192)}`],
  ["long-unicode-prefix", `${"한글".repeat(4096)}b`, `${"한글".repeat(4096)}c`],
];
const rows = [];
for (const [name, left, right] of cases) {
  for (const variant of ["equal", "bmp", "points", "hybrid"]) {
    const rawMs = { baseline: [], candidate: [] };
    for (let pair = -5; pair < 20; pair++)
      for (const version of pairOrder(pair + 5)) {
        const compare = engines[version === "baseline" ? "baseline" : variant];
        let result = 0;
        const started = performance.now();
        for (let i = 0; i < 2000; i++) result += compare(left, right);
        const ms = (performance.now() - started) / 2000;
        assert.equal(Math.sign(result), Math.sign(engines.baseline(left, right)));
        if (pair >= 0) rawMs[version].push(ms);
      }
    rows.push({ name, variant, ratio: pairedRatio(rawMs.baseline, rawMs.candidate), rawMs });
  }
}
await writeFile(
  new URL("./compare-micro.json", import.meta.url),
  JSON.stringify({ rows }, null, 2),
);
console.log(rows.map(({ name, variant, ratio }) => ({ name, variant, ratio: ratio.median })));

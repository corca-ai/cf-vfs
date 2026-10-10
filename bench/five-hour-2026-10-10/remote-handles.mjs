import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pairedRatio, pairOrder } from "../comparison.mjs";

const [output] = process.argv.slice(2);
assert.ok(output);
const vars = await readFile(new URL("../three-hour-2026-10-10/.dev.vars", import.meta.url), "utf8");
const token = vars.match(/^EVALUATION_TOKEN\s*=\s*["']?([^\r\n"']+)/mu)?.[1];
assert.ok(token);
const trials = 10;
const summarize = process.argv.includes("--summarize");
const saved = summarize ? JSON.parse(await readFile(output, "utf8")) : undefined;
const room = saved?.room ?? `full-handles-${randomUUID()}`;
const rows = saved?.rows ?? [];
if (!summarize)
  for (let pair = -1; pair < trials; pair++) {
    for (const files of [100, 1000]) {
      const url = new URL("/handles", process.env.EVALUATION_URL);
      url.searchParams.set("room", room);
      url.searchParams.set("files", files);
      url.searchParams.set("order", pairOrder(pair)[0]);
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(180000),
      });
      assert.ok(response.ok, `handles status ${response.status}`);
      const result = await response.json();
      assert.equal(result.build, process.env.CANDIDATE);
      for (const version of result.rows) {
        assert.equal(version.verified, true);
        for (const value of version.rows)
          if (pair >= 0)
            rows.push({ pair, files, version: version.version, colo: result.colo, ...value });
      }
      console.log(`handles pair ${pair} files ${files} colo ${result.colo}`);
      await writeFile(
        output,
        `${JSON.stringify({ room, trials, candidate: result.build, rows }, null, 2)}\n`,
      );
    }
  }
const metrics = [];
for (const files of [100, 1000])
  for (const operation of [...new Set(rows.map((x) => x.operation))]) {
    const baseline = rows.filter(
      (x) => x.files === files && x.operation === operation && x.version === "baseline",
    );
    const candidate = rows.filter(
      (x) => x.files === files && x.operation === operation && x.version === "candidate",
    );
    metrics.push({
      files,
      operation,
      ratio: [...baseline, ...candidate].every((x) => x.ms > 0)
        ? pairedRatio(
            baseline.map((x) => x.ms),
            candidate.map((x) => x.ms),
          )
        : null,
      timingNote:
        "DO clock may remain frozen; zero samples exclude timing claims. Native SQL costs remain valid.",
      baseline: baseline[0],
      candidate: candidate[0],
    });
  }
await writeFile(
  output,
  `${JSON.stringify({ room, trials, candidate: process.env.CANDIDATE, rows, metrics }, null, 2)}\n`,
);
console.log(JSON.stringify(metrics));

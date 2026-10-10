import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pairOrder } from "../comparison.mjs";

const [output] = process.argv.slice(2);
assert.ok(output);
const vars = await readFile(new URL("../three-hour-2026-10-10/.dev.vars", import.meta.url), "utf8");
const token = vars.match(/^EVALUATION_TOKEN\s*=\s*["']?([^\r\n"']+)/mu)?.[1];
assert.ok(token);
const room = `full-namespace-${randomUUID()}`;
const rows = [];
for (let pair = 0; pair < 3; pair++)
  for (const files of [100, 1000])
    for (const changes of [false, true])
      for (const operation of ["move", "copy"]) {
        const url = new URL("/namespace", process.env.EVALUATION_URL);
        for (const [key, value] of Object.entries({
          room,
          files,
          changes: changes ? "1" : "0",
          operation,
          order: pairOrder(pair)[0],
        }))
          url.searchParams.set(key, String(value));
        const response = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(180000),
        });
        assert.ok(response.ok, `namespace status ${response.status}`);
        const result = await response.json();
        assert.equal(result.build, process.env.CANDIDATE);
        for (const row of result.rows) {
          assert.equal(row.verified, true);
          rows.push({ pair, files, recordChanges: changes, colo: result.colo, ...row });
        }
        await writeFile(
          output,
          `${JSON.stringify({ engine: "cloudflare-native-sqlite", kind: "namespace-scaling-cost", room, candidate: result.build, rows }, null, 2)}\n`,
        );
        console.log(
          `namespace pair ${pair} files ${files} changes ${changes} operation ${operation}`,
        );
      }

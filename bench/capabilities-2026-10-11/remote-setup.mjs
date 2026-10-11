import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const vars = await readFile(new URL("../three-hour-2026-10-10/.dev.vars", import.meta.url), "utf8");
const token = vars.match(/^EVALUATION_TOKEN\s*=\s*["']?([^\r\n"']+)/mu)?.[1];
assert.ok(token);
const rows = [];
for (let pair = 0; pair < 10; pair++) {
  for (const mode of ["initial", "mutation"]) {
    const room = `setup-${randomUUID()}`;
    const url = new URL("https://cf-vfs-capabilities-evaluation.donghun.workers.dev/");
    url.searchParams.set("room", room);
    url.searchParams.set("mode", mode);
    url.searchParams.set("order", pair % 2 ? "candidate" : "baseline");
    let result;
    for (let retry = 0; retry < 12; retry++) {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60_000),
      });
      assert.ok(response.ok, `HTTP ${response.status}`);
      result = await response.json();
      assert.equal(result.build, "capabilities-28720507900c8a69");
      if (
        mode === "initial"
          ? result.initialIndexCost
          : result.rows.every((r) => "recordChanges" in r)
      )
        break;
      await delay(5000);
    }
    assert.ok(
      mode === "initial" ? result.initialIndexCost : result.rows.every((r) => "recordChanges" in r),
    );
    assert.ok(result.rows.every((r) => r.verified));
    rows.push({ pair, mode, room, ...result });
    await writeFile(
      new URL("./cf-setup-costs.json", import.meta.url),
      `${JSON.stringify({ rows }, null, 2)}\n`,
    );
  }
}
console.log("Verified ten native setup and feed-mutation cost samples.");

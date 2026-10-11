import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const vars = await readFile(new URL("../three-hour-2026-10-10/.dev.vars", import.meta.url), "utf8");
const token = vars.match(/^EVALUATION_TOKEN\s*=\s*["']?([^\r\n"']+)/mu)?.[1];
assert.ok(token);
const rows = [];
const rooms = [];
for (let pair = 0; pair < 10; pair++) {
  const room = `capabilities-${randomUUID()}`;
  rooms.push(room);
  const url = new URL("https://cf-vfs-capabilities-evaluation.donghun.workers.dev/");
  url.searchParams.set("room", room);
  url.searchParams.set("order", pair % 2 ? "candidate" : "baseline");
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  const result = await response.json();
  assert.equal(result.build, "capabilities-28720507900c8a69");
  assert.ok(result.rows.every((r) => r.verified));
  rows.push({ pair, room, ...result });
  await writeFile(
    new URL("./cf-native.json", import.meta.url),
    `${JSON.stringify({ rows, rooms }, null, 2)}\n`,
  );
  console.log(pair, result.colo, result.rows);
}

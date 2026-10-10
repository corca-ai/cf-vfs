import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const phase = process.argv[2];
assert.ok(["before", "after"].includes(phase));
const base = process.env.EVALUATION_URL ?? "https://cf-vfs-coding-evaluation.donghun.workers.dev";
const token = (await readFile(new URL(".dev.vars", import.meta.url), "utf8")).match(
  /^EVALUATION_TOKEN=(.+)$/m,
)[1];
const room = `restart-${Date.now()}`;
const records = [];
async function call(path, body = "", timeout = 30000) {
  const started = performance.now();
  const url = new URL(path, base);
  url.searchParams.set("room", room);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body,
      signal: AbortSignal.timeout(timeout),
    });
    const text = await response.text();
    const record = {
      path,
      status: response.status,
      value: JSON.parse(text),
      ms: performance.now() - started,
    };
    records.push(record);
    return record;
  } catch (error) {
    const record = { path, error: error.message, ms: performance.now() - started };
    records.push(record);
    return record;
  }
}
let passed = false;
try {
  assert.equal((await call("/setup?files=32")).status, 200);
  await call("/change?all=true");
  assert.equal((await call("/execute", "git add -A; git commit -m next")).value.exitCode, 0);
  const committed = (await call("/inspect")).value;
  const interrupted = await call("/restart?checkout=true");
  assert.equal(interrupted.status, 500);
  assert.match(interrupted.value.error, /restart during checkout/iu);
  const inspected = await call("/inspect");
  if (phase === "before") {
    assert.ok(inspected.error, "Expected stalled post-reset index inspection");
  } else {
    assert.equal(inspected.status, 200);
    assert.notEqual(inspected.value.instance, committed.instance);
    assert.equal(inspected.value.head, committed.head);
    const repaired = await call("/execute", "git checkout --force base; git status --porcelain");
    assert.equal(repaired.value.exitCode, 0);
    assert.equal(repaired.value.stdout, "");
  }
  passed = true;
} finally {
  await call("/clear");
  await writeFile(
    new URL(`restart-${phase}-cf.json`, import.meta.url),
    `${JSON.stringify({ phase, room, passed, records }, null, 2)}\n`,
  );
}
console.log(`${phase}: ${passed}`);

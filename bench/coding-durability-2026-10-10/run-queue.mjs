import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const token = (await readFile(new URL(".dev.vars", import.meta.url), "utf8")).match(
  /^EVALUATION_TOKEN=(.+)$/m,
)[1];
const base = process.env.EVALUATION_URL ?? "https://cf-vfs-coding-evaluation.donghun.workers.dev";
const room = `queue-${Date.now()}`;
async function call(path, body = "") {
  const url = new URL(path, base);
  url.searchParams.set("room", room);
  const start = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body,
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return { ...JSON.parse(text), clientMs: performance.now() - start };
}
async function execute(script) {
  const result = await call("/execute", script);
  assert.equal(result.exitCode, 0, result.stderr);
  return result;
}
const samples = [];
let complete = false;
try {
  await call("/setup?files=1000");
  await call("/change?all=true");
  await execute("git add -A; git commit -m next");
  for (let round = -1; round < 5; round++) {
    const idle = await execute("git status --porcelain");
    assert.equal(idle.stdout, "");
    const busy = await call("/pair");
    assert.equal(busy.results.length, 2);
    for (const result of busy.results) assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(busy.results[1].stdout, "");
    if (round >= 0)
      samples.push({
        round,
        idleClientMs: idle.clientMs,
        busyClientMs: busy.clientMs,
        differenceMs: busy.clientMs - idle.clientMs,
      });
    await execute("git checkout main");
  }
  complete = true;
} finally {
  await call("/clear");
  await writeFile(
    new URL("queue-cf.json", import.meta.url),
    `${JSON.stringify({ complete, room, samples, measurement: "Client wall time for idle status versus status admitted behind checkout in the same RPC. Difference includes checkout and scheduling; not a pure queue-wait timestamp." }, null, 2)}\n`,
  );
}
console.log(JSON.stringify(samples));

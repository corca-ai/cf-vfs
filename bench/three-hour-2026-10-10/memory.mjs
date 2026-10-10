import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const vars = await readFile(new URL("./.dev.vars", import.meta.url), "utf8");
const token = vars.match(/^EVALUATION_TOKEN\s*=\s*["']?([^\r\n"']+)/mu)?.[1];
assert.ok(token);
const room = `full-memory-${randomUUID()}`;
async function request(path, version) {
  const url = new URL(path, "https://cf-vfs-full-evaluation.donghun.workers.dev");
  url.searchParams.set("room", room);
  url.searchParams.set("version", version);
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60000),
  });
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  assert.equal(value.build, process.env.CANDIDATE);
  return value;
}
const results = [];
try {
  for (const version of ["baseline", "candidate"]) {
    await request("/setup", version);
    const result = await request("/memory", version);
    results.push(result);
    const rows = result.rows[0].rows;
    assert.equal(rows[1].exitCode, 0);
    assert.equal(rows[1].verified, true);
    assert.equal(rows[1].peakReserved, version === "baseline" ? 131072 : 65536);
    assert.equal(rows[0].exitCode, version === "baseline" ? 1 : 0);
    if (version === "candidate") assert.equal(rows[0].verified, true);
    await request("/clear", version);
  }
} finally {
  await request("/clear", "baseline");
}
await writeFile(
  process.argv[2],
  JSON.stringify(
    {
      metric: "peak shell-owned buffer reservation, not process RSS",
      inputBytes: 65536,
      baseline: "02f2ef3",
      at: new Date().toISOString(),
      results,
    },
    null,
    2,
  ) + "\n",
);
console.log("CF buffer reservation: 128 KiB -> 64 KiB; 96 KiB budget: failure -> success");

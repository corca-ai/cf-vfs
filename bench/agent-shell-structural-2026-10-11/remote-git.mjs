import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { distribution, pairedRatio, pairOrder } from "../comparison.mjs";

const token = (
  await readFile(new URL("../three-hour-2026-10-10/.dev.vars", import.meta.url), "utf8")
).match(/^EVALUATION_TOKEN\s*=\s*["']?([^\r\n"']+)/mu)?.[1];
assert.ok(token);
const colocated = process.env.COLOCATED === "1";
const build = process.env.CANDIDATE ?? "structural-git-wrapper-v1",
  room = `full-${randomUUID()}`,
  output = process.argv[2];
async function request(path, version, index) {
  const u = new URL(
    path,
    process.env.EVALUATION_URL ?? "https://cf-vfs-structural-validation.donghun.workers.dev",
  );
  u.searchParams.set("room", colocated ? room : `${room}-${version}`);
  u.searchParams.set("version", version);
  if (process.env.COLD_COMMAND === "1") u.searchParams.set("cold", "1");
  if (index !== undefined) u.searchParams.set("index", index);
  const r = await fetch(u, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(180000),
  });
  const value = await r.json();
  assert.ok(r.ok, JSON.stringify(value));
  assert.equal(value.build, build);
  if (value.doBuild !== undefined) assert.equal(value.doBuild, build);
  return value;
}
const rows = [];
const retries = [];
try {
  for (const v of ["baseline", "candidate"]) await request("/prepare-git", v);
  for (let pair = -3; pair < 20; pair++) {
    const startLength = rows.length;
    try {
      const verified = {};
      for (const v of pairOrder(pair + 3)) {
        if (colocated) await request("/prepare-git", v);
        if (process.env.WARM_HASHES === "1") await request("/verify-git", v);
        const edit = await request("/edit-git", v, pair),
          add = await request("/add-git", v);
        verified[v] = await request("/verify-git", v);
        const commit = await request("/commit-git", v, pair);
        verified[v].oid = commit.oid;
        if (pair >= 0) rows.push({ pair, version: v, edit, add, commit });
      }
      assert.equal(verified.baseline.oid, verified.candidate.oid);
      assert.equal(verified.baseline.status, verified.candidate.status);
      assert.equal(verified.candidate.status.split("\n").filter(Boolean).length, 10);
      const blocks = (s) => s.split(/(?=^diff --git )/m).sort();
      assert.deepEqual(blocks(verified.baseline.diff), blocks(verified.candidate.diff));
      await writeFile(output, JSON.stringify({ build, room, rows, retries }, null, 2));
      console.error("pair", pair, "verified");
    } catch (error) {
      if (!String(error).includes("Missing Git fixture") || retries.length >= 5) throw error;
      rows.splice(startLength);
      retries.push({ pair, reason: String(error), at: new Date().toISOString() });
      console.error("Discarding entire pair after object restart", pair);
      pair--;
    }
  }
} finally {
  await Promise.allSettled(["baseline", "candidate"].map((v) => request("/clear", v)));
}
const select = (v, f) => rows.filter((r) => r.version === v).map(f);
const result = {
  build,
  room,
  colocated,
  coldCommand: process.env.COLD_COMMAND === "1",
  warmHashes: process.env.WARM_HASHES === "1",
  retries,
  files: 1000,
  changed: 10,
  pairs: 20,
  warmups: 3,
  rows,
  baseline: distribution(select("baseline", (r) => r.add.ms)),
  candidate: distribution(select("candidate", (r) => r.add.ms)),
  ratio: pairedRatio(
    select("baseline", (r) => r.add.ms),
    select("candidate", (r) => r.add.ms),
  ),
  cycleRatio: pairedRatio(
    select("baseline", (r) => r.edit.ms + r.add.ms + r.commit.ms),
    select("candidate", (r) => r.edit.ms + r.add.ms + r.commit.ms),
  ),
};
await writeFile(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, rows: undefined }, null, 2));

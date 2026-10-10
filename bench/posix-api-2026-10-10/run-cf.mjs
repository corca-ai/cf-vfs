import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { distribution, pairedRatio, pairOrder } from "../comparison.mjs";

const base = "https://cf-vfs-posix-api-evaluation.donghun.workers.dev";
const token = (await readFile(new URL(".dev.vars", import.meta.url), "utf8")).match(
  /^EVALUATION_TOKEN=(.+)$/m,
)[1];
const configuration = {
  colocated: process.env.COLOCATED === "1",
  pairs: Number(process.env.PAIRS ?? 8),
  warmups: Number(process.env.WARMUPS ?? 2),
};
const prefix = `posix-${Date.now()}`,
  rooms = new Set(),
  rows = [];
const names = process.env.OPERATIONS?.split(",") ?? [
  "stat-shallow",
  "stat-deep",
  "stat-link",
  "stat-denied",
  "read-deep",
  "overwrite",
  "append-small",
  "append-large-tail",
  "mkdir-wide",
  "mkdir-deep",
  "rename",
  "unlink",
  "rmdir",
  "batch-parents",
];
async function call(room, path, name, version) {
  rooms.add(room);
  const url = new URL(path, base);
  url.search = new URLSearchParams({
    room,
    ...(name ? { name } : {}),
    ...(version ? { version } : {}),
  });
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(120000),
  });
  const r = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(r));
  return r;
}
try {
  for (const profile of [false, true])
    for (
      let pair = profile ? 0 : -configuration.warmups;
      pair < (profile ? 1 : configuration.pairs);
      pair++
    ) {
      for (const version of pairOrder(pair)) {
        const room = `${prefix}-${pair + 2}-${configuration.colocated ? "shared" : version}${profile ? "-profile" : ""}`;
        for (const name of names) {
          await call(room, "/setup", name, version);
          const measured = await call(room, "/measure", name, version);
          assert.equal((await call(room, "/validate", name, version)).value.ok, true);
          if (pair >= 0) rows.push({ pair, version, profile, name, ...measured });
          await writeFile(
            process.argv[2],
            `${JSON.stringify({ base, prefix, configuration, rows }, null, 2)}\n`,
          );
        }
        await call(room, "/clear");
      }
      console.error("pair", pair, profile ? "profile" : "timing");
    }
  const summary = {};
  for (const name of names) {
    const a = rows.filter((r) => !r.profile && r.name === name && r.version === "baseline"),
      b = rows.filter((r) => !r.profile && r.name === name && r.version === "candidate");
    summary[name] = {
      before: distribution(a.map((r) => r.rpcMs)),
      after: distribution(b.map((r) => r.rpcMs)),
      ratio: pairedRatio(
        a.map((r) => r.rpcMs),
        b.map((r) => r.rpcMs),
      ),
    };
  }
  await writeFile(
    process.argv[2],
    `${JSON.stringify({ base, prefix, configuration, summary, rows }, null, 2)}\n`,
  );
  console.log(JSON.stringify(summary));
} finally {
  for (const room of rooms)
    await call(room, "/clear").catch((e) => console.error("cleanup", room, e.message));
}

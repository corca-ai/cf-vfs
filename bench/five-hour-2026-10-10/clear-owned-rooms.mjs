import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

// Run after every timing driver finishes, before deleting our private Worker.
const base = "https://cf-vfs-five-hour-evaluation.donghun.workers.dev";
const vars = await readFile(new URL("../three-hour-2026-10-10/.dev.vars", import.meta.url), "utf8");
const token = vars.match(/^EVALUATION_TOKEN\s*=\s*["']?([^\r\n"']+)/mu)?.[1];
assert.ok(token);
const rooms = new Set();
for (const name of await readdir(new URL("./", import.meta.url))) {
  if (!name.startsWith("cf-") || !/\.json(?:\.gz)?$/u.test(name)) continue;
  const bytes = await readFile(new URL(name, import.meta.url));
  const value = JSON.parse(name.endsWith(".gz") ? gunzipSync(bytes) : bytes);
  if (!value.room || (value.baseUrl && value.baseUrl !== base)) continue;
  assert.match(value.room, /^full-[a-z0-9-]{1,100}$/u);
  const names = value.protocol ? [value.room, `${value.room}-profile`] : [value.room];
  for (const room of names) {
    if (value.colocated === true) rooms.add(room);
    else for (const version of ["baseline", "candidate"]) rooms.add(`${room}-${version}`);
  }
}
const cleared = [];
for (const room of rooms) {
  const url = new URL("/clear", base);
  url.searchParams.set("room", room);
  url.searchParams.set("version", "baseline"); // Addresses this exact owned name.
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok, `Cleanup failed for ${room}: ${response.status}`);
  const value = await response.json();
  assert.equal(value.ok, true);
  assert.equal(value.build, "five-hour-round11-47e3e8c47d4b");
  cleared.push(room);
}
await writeFile(
  new URL("cf-owned-room-cleanup.json", import.meta.url),
  `${JSON.stringify(
    {
      at: new Date().toISOString(),
      base,
      cleared,
      note: "Explicit final clear supplements the drivers' finally cleanup. The handle probe with a lost room identifier already clears each operation internally.",
    },
    null,
    2,
  )}\n`,
);
console.log(`Verified clear responses for ${cleared.length} owned evaluation rooms`);

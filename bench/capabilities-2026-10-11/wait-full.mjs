import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const vars = await readFile(new URL("../three-hour-2026-10-10/.dev.vars", import.meta.url), "utf8");
const token = vars.match(/^EVALUATION_TOKEN\s*=\s*["']?([^\r\n"']+)/mu)?.[1];
assert.ok(token);
const build = process.argv[2];
assert.ok(build);
const room = `full-ready-${randomUUID()}`;
const observations = [];
for (let attempt = 0; attempt < 30; attempt++) {
  const url = new URL("/clear", "https://cf-vfs-capabilities-full.donghun.workers.dev");
  url.searchParams.set("room", room);
  url.searchParams.set("version", "baseline");
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  assert.ok(response.ok);
  const value = await response.json();
  observations.push({ at: new Date().toISOString(), ...value });
  if (value.build === build) {
    await writeFile(
      new URL("./full-build-ready.json", import.meta.url),
      `${JSON.stringify({ room, observations }, null, 2)}\n`,
    );
    console.log(build);
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
throw new Error("Deployment did not propagate");

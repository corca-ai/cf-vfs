import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const base = new URL(process.env.EVALUATION_URL ?? "http://localhost:8798");
const token = (
  await readFile(new URL("../coding-durability-2026-10-10/.dev.vars", import.meta.url), "utf8")
).match(/^EVALUATION_TOKEN=(.+)$/m)[1];
const room = `coding-${Date.now()}`;
const rooms = new Set();
async function call(path, body = "", params = {}, suffix = "") {
  const name = room + suffix;
  rooms.add(name);
  const url = new URL(path, base);
  url.search = new URLSearchParams({ room: name, ...params }).toString();
  if (process.env.EVALUATION_TRACE === "1") console.error("begin", path, params);
  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body,
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text);
  const value = JSON.parse(text);
  if (process.env.EVALUATION_TRACE === "1") console.error("done", path, value.exitCode ?? "");
  return { ...value, clientMs: performance.now() - started };
}
async function execute(script, params = {}, suffix = "") {
  const value = await call("/execute", script, params, suffix);
  assert.equal(value.exitCode, 0, value.stderr);
  return value;
}
const samples = [],
  profiles = [];
try {
  for (const mixed of [false, true]) {
    for (const profile of process.env.PROFILE_ONLY === "1" ? [true] : [false, true]) {
      const suffix = `${mixed ? "mixed" : "small"}${profile ? "-profile" : ""}`;
      for (let n = profile ? 0 : -1; n < (profile ? 1 : 5); n++) {
        await call("/setup", "", { files: "1000", mixed: String(mixed) }, suffix);
        await call("/change", "", { all: "true" }, suffix);
        await execute("git add -A; git commit -m next", {}, suffix);
        const result = await execute(
          "git clone /repo /copy",
          profile ? { profile: "true" } : {},
          suffix,
        );
        if (n >= 0) (profile ? profiles : samples).push({ mixed, n, ...result });
        console.error(mixed, profile, n, Math.round(result.clientMs));
      }
    }
  }
} finally {
  const output = new URL(process.argv[2], import.meta.url);
  await writeFile(
    output,
    `${JSON.stringify({ room, rooms: [...rooms], samples, profiles }, null, 2)}\n`,
  );
  const cleanup = [];
  for (const name of rooms) {
    try {
      cleanup.push({ name, result: await call("/clear", "", {}, name.slice(room.length)) });
    } catch (error) {
      cleanup.push({ name, error: String(error) });
    }
  }
  await writeFile(output, `${JSON.stringify({ room, samples, profiles, cleanup }, null, 2)}\n`);
}

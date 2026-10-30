import { readFileSync, writeFileSync } from "node:fs";

// Usage: node cf-check.mjs FIXTURES
//
// The calibration's probes on Cloudflare: a 10,000-page instance with default
// limits and a 2,000-page instance at scale 0.2 on the evaluation Worker,
// comparing outcomes and Worker time. The token comes from eval/.secrets.json
// and is never printed.

const BASE = "https://eval.vfs.borca.ai/api/instances";
const [fixtures] = process.argv.slice(2);
const token = JSON.parse(
  readFileSync(new URL("../../eval/.secrets.json", import.meta.url), "utf8"),
).AGENT_EVAL_TOKEN;
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "User-Agent": "cf-vfs-scaled-check/1",
};

async function call(method, path, payload) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
  return text === "" ? undefined : JSON.parse(text);
}

const PROBES = [
  ["find count", "find wiki -name '*.md' | wc -l"],
  ["for over $(find)", "n=0; for f in $(find wiki -name '*.md'); do n=$((n+1)); done; echo $n"],
  ["grep -rl", "grep -rl 'owner:' wiki | wc -l"],
  [
    "grep -o links ranked",
    "grep -rhoE '\\[\\[[^]|#]+' wiki | sort | uniq -c | sort -rn | head -3 | wc -l",
  ],
  [
    "grep -o inbound pipeline",
    "grep -roE '\\[\\[[^]|#]+' --include='*.md' wiki | sed -e 's|^wiki/||' -e 's|\\.md:\\[\\[| |' | awk '{ n = $1; sub(/.*\\//, \"\", n); if (n != $2) print n, $2 }' | sort -u | awk '{ print $2 }' | sort | uniq -c | wc -l",
  ],
  ["awk owners", "awk '/^owner:/ { n++ } END { print n }' $(find wiki -name '*.md')"],
  ["cat glob wc", "cat wiki/*/*.md wiki/*/*/*.md | wc -c"],
  ["awiki lint (first)", "awiki lint -r -root wiki | head -1 | cut -c1-20"],
  ["awiki graph orphans", "awiki graph -r -root wiki | grep -c ' inbound=0 '"],
];

async function instance(name, scale) {
  const { files } = JSON.parse(readFileSync(`${fixtures}/${name}.json`, "utf8"));
  const { instance } = await call("POST", "", {
    label: `scaled-check-${name}-${scale}`,
    ttlSeconds: 3600,
    files: [],
    scale,
  });
  const entries = Object.entries(files).map(([path, content]) => ({
    path: `wiki/${path}`,
    content,
  }));
  let batch = [];
  let bytes = 0;
  for (const entry of entries) {
    const size = Buffer.byteLength(entry.content) + 128;
    if (batch.length === 1000 || bytes + size > 7 * 1024 * 1024) {
      await call("POST", `/${instance.id}/files`, { files: batch });
      batch = [];
      bytes = 0;
    }
    batch.push(entry);
    bytes += size;
  }
  if (batch.length > 0) await call("POST", `/${instance.id}/files`, { files: batch });
  return instance.id;
}

async function run(id) {
  const results = [];
  for (const [, script] of PROBES) {
    const response = await call("POST", `/${id}/exec`, { script });
    results.push({ exitCode: response.exitCode, stderr: response.stderr.trim().slice(0, 80) });
  }
  const { entries } = await call("GET", `/${id}/log?after=0&limit=100`);
  return results.map((result, index) => ({
    ...result,
    workerMs: entries[index]?.workerMs ?? null,
    limit: entries[index]?.limits?.[0]?.limit ?? null,
  }));
}

const large = await instance("s3-10k", 1);
const small = await instance("s3", 0.2);
try {
  const full = await run(large);
  const scaled = await run(small);
  const rows = PROBES.map(([name], index) => ({ name, full: full[index], scaled: scaled[index] }));
  for (const { name, full: f, scaled: s } of rows) {
    const same = (f.exitCode === 0) === (s.exitCode === 0) && f.limit === s.limit;
    console.log(
      `${same ? "  " : "!!"} ${name.padEnd(26)} 10k: exit ${f.exitCode} ${String(f.limit ?? "").padEnd(16)} ${String(f.workerMs).padStart(6)} ms   ` +
        `2k@0.2: exit ${s.exitCode} ${String(s.limit ?? "").padEnd(16)} ${String(s.workerMs).padStart(6)} ms   ratio ${(f.workerMs / s.workerMs).toFixed(1)}`,
    );
  }
  writeFileSync(new URL("./cf-check.json", import.meta.url), `${JSON.stringify(rows, null, 1)}\n`);
} finally {
  await call("DELETE", `/${large}`).catch(() => undefined);
  await call("DELETE", `/${small}`).catch(() => undefined);
}

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { distribution, pairedRatio, pairOrder } from "../comparison.mjs";

const base = new URL(
  process.env.NO_API_URL ?? "https://cf-vfs-no-api-evaluation.donghun.workers.dev",
);
const token = (await readFile(new URL(".dev.vars", import.meta.url), "utf8")).match(
  /^EVALUATION_TOKEN=(.+)$/m,
)[1];
const prefix = `noapi-${Date.now()}`;
const rooms = new Set();
const rows = [];
const preparation = [];
async function call(room, path, params = {}) {
  rooms.add(room);
  const url = new URL(path, base);
  url.search = new URLSearchParams({ room, ...params });
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(120000),
  });
  const value = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(value));
  return value;
}
try {
  if (process.env.SKIP_CACHE !== "1")
    for (const profile of [false, true])
      for (let pair = profile ? 0 : -1; pair < (profile ? 1 : 8); pair++) {
        const pairRows = [];
        for (const version of pairOrder(pair)) {
          const room = `${prefix}-cache-${pair + 1}-${version}${profile ? "-profile" : ""}`;
          await call(room, "/setup");
          for (const [name, operation] of [
            ["status-first", "status"],
            ["status-repeat", "status"],
            ["add-clean", "add"],
          ]) {
            const r = await call(room, "/measure", { operation });
            assert.equal(r.value.stdout, "");
            if (pair >= 0)
              pairRows.push({ experiment: "cache", version, pair, name, profile, ...r });
          }
          await call(room, "/change");
          for (const [name, operation] of [
            ["status-one", "status"],
            ["add-one", "add"],
          ]) {
            const r = await call(room, "/measure", { operation });
            if (name === "status-one") assert.match(r.value.stdout, / M "f7"/);
            if (pair >= 0)
              pairRows.push({ experiment: "cache", version, pair, name, profile, ...r });
          }
          if (process.env.EXPANDED === "1") {
            await call(room, "/change", { all: "true" });
            const added = await call(room, "/measure", { operation: "add-all" });
            if (pair >= 0)
              pairRows.push({
                experiment: "cache",
                version,
                pair,
                name: "add-all",
                profile,
                ...added,
              });
            await call(room, "/commit");
            const checked = await call(room, "/measure", { operation: "checkout-all" });
            if (pair >= 0)
              pairRows.push({
                experiment: "cache",
                version,
                pair,
                name: "checkout-all",
                profile,
                ...checked,
              });
            assert.equal((await call(room, "/validate")).value.verified, 1000);
          }
        }
        rows.push(...pairRows);
        await writeFile(
          process.argv[2],
          JSON.stringify({ prefix, preparation, rows }, null, 2) + "\n",
        );
        console.error("cache pair", pair, profile ? "profile" : "timing");
      }
  if (process.env.SKIP_PACK !== "1")
    for (const profile of [false, true]) {
      const names = {
        baseline: `${prefix}-pack-baseline${profile ? "-profile" : ""}`,
        candidate: `${prefix}-pack-${process.env.PACK_BASELINE === "1" ? "baseline-packed" : "candidate"}${profile ? "-profile" : ""}`,
      };
      for (const version of ["baseline", "candidate"]) {
        await call(names[version], "/setup", { generations: "2", pack: "false" });
        if (version === "candidate")
          preparation.push({ version, profile, ...(await call(names[version], "/pack")) });
      }
      for (let pair = profile ? 0 : -2; pair < (profile ? 1 : 8); pair++)
        for (const version of pairOrder(pair)) {
          const room = names[version];
          await call(room, "/prepare-clone");
          for (const [name, operation] of [
            ["clone", "clone"],
            ["checkout", "checkout"],
          ]) {
            const r = await call(room, "/measure", { operation });
            if (pair >= 0) rows.push({ experiment: "pack", version, pair, name, profile, ...r });
            await writeFile(
              process.argv[2],
              JSON.stringify({ prefix, preparation, rows }, null, 2) + "\n",
            );
          }
          const result = await call(room, "/validate");
          assert.equal(result.value.verified, 1000);
        }
      console.error("pack", profile ? "profile" : "timing", "done");
    }
  const summary = {};
  for (const experiment of ["cache", "pack"])
    for (const name of new Set(
      rows.filter((r) => r.experiment === experiment).map((r) => r.name),
    )) {
      const a = rows
          .filter(
            (r) =>
              r.experiment === experiment &&
              r.name === name &&
              !r.profile &&
              r.version === "baseline",
          )
          .map((r) => r.rpcMs),
        b = rows
          .filter(
            (r) =>
              r.experiment === experiment &&
              r.name === name &&
              !r.profile &&
              r.version === "candidate",
          )
          .map((r) => r.rpcMs);
      summary[`${experiment}:${name}`] = {
        before: distribution(a),
        after: distribution(b),
        ratio: pairedRatio(a, b),
      };
    }
  await writeFile(
    process.argv[2],
    JSON.stringify({ base: String(base), prefix, preparation, summary, rows }, null, 2) + "\n",
  );
  console.log(JSON.stringify(summary));
} finally {
  for (const room of rooms)
    await call(room, "/clear").catch((e) => console.error("Cleanup failed", room, e.message));
}

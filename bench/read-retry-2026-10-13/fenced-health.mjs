import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { neverConnected } from "../connection-errors.mjs";

const calibration = process.argv.includes("--calibration");
const root = "bench/read-retry-2026-10-13",
  plan = JSON.parse(
    await readFile(
      root + (calibration ? "/cf-private-calibration-plan.json" : "/cf-fenced-plan.json"),
      "utf8",
    ),
  );
const { PUBLIC_BENCHMARK_TOKEN: token } = JSON.parse(
  await readFile("/tmp/cf-vfs-read-evaluation-secrets-20261014.json", "utf8"),
);
const group = Number(process.argv[2] ?? 1);
assert.ok(group === 1 || group === 2);
const deadline = Date.now() + 10 * 60_000;
for (;;) {
  try {
    const response = await fetch(plan.url + `/repeat?group=${group}&pair=-1`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(180000),
    });
    const text = await response.text();
    await writeFile(
      root +
        (calibration
          ? `/cf-private-calibration-health-${group}.json`
          : `/cf-fenced-health-${group}.json`),
      JSON.stringify(
        {
          status: response.status,
          body: JSON.parse(text),
          note: "Untimed pre-cohort propagation/compatibility probe, never adoption timing evidence",
        },
        null,
        2,
      ) + "\n",
    );
    assert.equal(response.status, 200);
    const value = JSON.parse(text);
    assert.equal(value.build, calibration ? plan.build : plan.candidateBuild);
    console.log({ build: value.build, checks: value.group.verified });
    break;
  } catch (error) {
    if (!neverConnected(error) || Date.now() >= deadline) throw error;
    console.error("Health probe not sent; retrying connection");
    await delay(2000);
  }
}

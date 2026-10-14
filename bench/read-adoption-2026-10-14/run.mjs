import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";

const root = "bench/read-adoption-2026-10-14";
const plan = JSON.parse(await readFile(`${root}/plan.json`, "utf8"));
const runtime = JSON.parse(await readFile(`${root}/deployment.json`, "utf8"));
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
  console.error("Stop after collecting active run; no further claims.");
});
async function unused(output) {
  for (const path of [output, `${output}.gz`, `${output}.claim.json`]) {
    await access(path).then(
      () => {
        throw Error(`Refusing to overwrite ${path}`);
      },
      (error) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
  }
}
const slots = ["full", "task"].flatMap((kind) =>
  Array.from({ length: kind === "full" ? plan.fullRuns : plan.taskRuns }, (_, i) => ({
    kind,
    index: i + 1,
    output: `${root}/public-${kind}-${i + 1}.json`,
  })),
);
const resume = process.argv.includes("--resume");
const ids = new Set();
const pending = [];
for (const slot of slots) {
  let snapshot;
  if (resume) {
    try {
      snapshot = JSON.parse(await readFile(slot.output, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (snapshot) {
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.result.buildId, runtime.build);
    assert.equal(snapshot.result.commitHash, runtime.commit);
    assert.equal(snapshot.result.deploymentId, runtime.deployment);
    assert.equal(snapshot.result.rows.length, slot.kind === "full" ? 190 : 1);
    assert.equal(snapshot.result.verified, slot.kind === "full" ? 212268 : 28028);
    assert.ok(!ids.has(snapshot.result.runId));
    ids.add(snapshot.result.runId);
  } else {
    await unused(slot.output);
    pending.push(slot);
  }
}
for (const { kind, output } of pending) {
  if (stopping) throw Error("Stopped before next claim");
  await unused(output);
  const child = spawn(
    process.execPath,
    [
      "bench/public-remote.mjs",
      "--url",
      plan.url,
      "--build",
      runtime.build,
      ...(kind === "task" ? ["--task"] : []),
      "--out",
      output,
    ],
    { stdio: "inherit" },
  );
  const code = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  assert.equal(code, 0, `Benchmark client failed: ${output}`);
  const snapshot = JSON.parse(await readFile(output, "utf8"));
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.result.buildId, runtime.build);
  assert.equal(snapshot.result.commitHash, runtime.commit);
  assert.equal(snapshot.result.deploymentId, runtime.deployment);
  assert.equal(snapshot.result.rows.length, kind === "full" ? 190 : 1);
  assert.equal(snapshot.result.verified, kind === "full" ? 212268 : 28028);
  assert.ok(!ids.has(snapshot.result.runId));
  ids.add(snapshot.result.runId);
}

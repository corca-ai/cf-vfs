import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const base = new URL(process.env.EVALUATION_URL ?? "http://localhost:8798");
const token = (await readFile(new URL(".dev.vars", import.meta.url), "utf8")).match(
  /^EVALUATION_TOKEN=(.+)$/m,
)[1];
const room = `coding-${Date.now()}`;
const sampleCount = Number(process.env.EVALUATION_SAMPLES ?? 5);
assert.ok(Number.isInteger(sampleCount) && sampleCount >= 3 && sampleCount <= 10);
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
async function restart(params = {}) {
  try {
    await call("/restart", "", params);
    assert.fail("Restart must interrupt RPC");
  } catch (error) {
    assert.match(error.message, /restart|reset|abort|internal error/iu);
  }
}
const reliability = [],
  samples = [],
  profiles = [];
try {
  if (process.env.SKIP_RELIABILITY !== "1") {
    const initial = await call("/setup", "", { files: "32" });
    await execute(
      "git clone /repo /copy; git -C /copy config user.name Evaluation; git -C /copy config user.email eval@example.invalid",
    );
    await call("/change", "", { all: "true" });
    const edited = await call("/inspect");
    await call("/quota", "", { bytes: "1" });
    const failed = await call("/execute", "git add -A");
    assert.notEqual(failed.exitCode, 0);
    assert.match(failed.stderr, /quota/iu);
    const afterFailure = await call("/inspect");
    assert.equal(afterFailure.indexHash, initial.indexHash);
    assert.equal(afterFailure.head, initial.head);
    assert.equal(afterFailure.body, edited.body);
    await call("/quota", "", { bytes: String(32 * 1024 * 1024) });
    await execute("git add -A; git commit -m next");
    const committed = await call("/inspect");
    assert.notEqual(committed.head, initial.head);
    reliability.push({ scenario: "real-quota-add-retry-commit", initial, afterFailure, committed });
    await restart({ checkout: "true" });
    const partial = await call("/inspect");
    assert.notEqual(partial.instance, committed.instance);
    assert.equal(partial.head, committed.head);
    const guarded = await call("/execute", "git checkout base");
    assert.notEqual(guarded.exitCode, 0);
    await execute("git checkout --force base");
    const repaired = await call("/inspect");
    assert.equal(repaired.body, initial.body);
    assert.equal(repaired.head, initial.head);
    assert.equal((await execute("git status --porcelain")).stdout, "");
    reliability.push({
      scenario: "actual-do-restart-mid-checkout-force-recovery",
      partial,
      repaired,
    });
    await restart();
    const persisted = await call("/inspect");
    assert.notEqual(persisted.instance, repaired.instance);
    assert.equal(persisted.head, repaired.head);
    assert.equal(persisted.indexHash, repaired.indexHash);
    assert.equal(persisted.body, repaired.body);
    reliability.push({
      scenario: "completed-file-index-history-survive-restart",
      before: repaired,
      after: persisted,
    });
    await call("/quota", "", { bytes: "1" });
    const accepted = await call("/edit", "pending editor text\n".repeat(200));
    await delay(600);
    const unsaved = await call("/inspect");
    assert.equal(unsaved.body, initial.body);
    assert.ok(unsaved.notices.some((notice) => notice.includes("error")));
    await restart();
    const lost = await call("/inspect");
    assert.notEqual(lost.instance, accepted.instance);
    assert.equal(lost.body, initial.body);
    reliability.push({
      scenario: "unsaved-editor-memory-is-lost-on-restart",
      accepted,
      unsaved,
      after: lost,
      classification: "known-durability-limit-not-a-saved-file-loss",
    });
    await call("/quota", "", { bytes: String(32 * 1024 * 1024) });
    for (const operation of [
      "cancel-mid-add",
      "partial-add-retry",
      "index-capacity",
      "checkout-failure",
    ])
      reliability.push({ scenario: operation, ...(await call("/recovery", "", { operation })) });
  }
  console.error(`Reliability: ${reliability.length} scenarios checked`);
  if (process.env.RELIABILITY_ONLY !== "1") {
    for (const mixed of [false, true]) {
      for (let round = -1; round < sampleCount; round++) {
        const suffix = "-timing";
        const setup = await call("/setup", "", { files: "1000", mixed: String(mixed) }, suffix);
        await call("/change", "", { all: "true" }, suffix);
        for (const [operation, script] of [
          ["add-all-changed", "git add -A"],
          ["commit", "git commit -m next"],
          ["clone", "git clone /repo /copy"],
          ["checkout-base", "git checkout base"],
          ["checkout-main", "git checkout main"],
        ]) {
          const value = await execute(script, {}, suffix);
          if (round >= 0) samples.push({ mixed, round, operation, ...value });
        }
        assert.equal((await execute("git status --porcelain", {}, suffix)).stdout, "");
        const checked = await call("/inspect", "", {}, suffix);
        assert.equal(checked.verified, 1000);
        assert.notEqual(checked.body, setup.body);
        assert.equal(checked.body.length, setup.body.length);
      }
      const suffix = "-profile";
      await call("/setup", "", { files: "1000", mixed: String(mixed) }, suffix);
      await call("/change", "", { all: "true" }, suffix);
      for (const [operation, script] of [
        ["add-all-changed", "git add -A"],
        ["commit", "git commit -m next"],
        ["clone", "git clone /repo /copy"],
        ["checkout-base", "git checkout base"],
        ["checkout-main", "git checkout main"],
      ])
        profiles.push({
          mixed,
          operation,
          ...(await execute(script, { profile: "true" }, suffix)),
        });
    }
    // Occupy the real host queue; a following Git command records waiting separately.
    const suffix = "-timing";
    for (let round = 0; round < sampleCount; round++) {
      const idle = await execute("git status --porcelain", {}, suffix);
      samples.push({ operation: "queue-idle-status", round, ...idle });
      const pair = await call("/pair", "", {}, suffix);
      const [first, second] = pair.results;
      assert.equal(first.exitCode, 0, first.stderr);
      assert.equal(second.exitCode, 0, second.stderr);
      assert.equal(second.stdout, "");
      samples.push({
        operation: "queue-holder-checkout",
        round,
        ...first,
        clientMs: pair.clientMs,
      });
      samples.push({ operation: "queue-waiter-status", round, ...second, clientMs: pair.clientMs });
      await execute("git checkout main", {}, suffix);
    }
  }
} finally {
  for (const name of rooms) {
    const suffix = name.slice(room.length);
    await call("/clear", "", {}, suffix).catch((error) =>
      console.error(`Cleanup failed: ${error.message}`),
    );
  }
  const output = {
    url: base.origin,
    room,
    completedAt: new Date().toISOString(),
    reliability,
    samples,
    profiles,
  };
  await writeFile(
    new URL(
      process.env.EVALUATION_OUTPUT ?? (base.hostname === "localhost" ? "local.json" : "cf.json"),
      import.meta.url,
    ),
    `${JSON.stringify(output, null, 2)}\n`,
  );
}
console.log(
  `Completed ${reliability.length} reliability scenarios, ${samples.length} timed samples, ${profiles.length} profiles`,
);

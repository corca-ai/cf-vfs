import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";

const root = "bench/read-retry-2026-10-13";
const worktree = "/tmp/cf-vfs-read-calibration-20261014";
const plan = JSON.parse(await readFile(`${root}/cf-private-calibration-plan.json`, "utf8"));
const cohort = JSON.parse(await readFile(`${root}/cf-fenced-plan.json`, "utf8"));
async function assertUnused(output) {
  for (const path of [output, `${output}.gz`, `${output}.claim.json`]) {
    await access(path).then(
      () => {
        throw Error("Refusing to overwrite " + path);
      },
      (error) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
  }
}
// Check every slot before deployment, so rerunning cannot reset an active cohort.
for (const name of plan.outputs) await assertUnused(`${root}/${name}`);
for (const version of ["baseline", "candidate"])
  for (let i = 1; i <= 5; i++) {
    const s = JSON.parse(
      await readFile(
        `${root}/cf-${version === "baseline" ? "clean" : "fenced"}-${version}-task-${i}.json`,
        "utf8",
      ),
    );
    assert.equal(s.status, "ready");
    assert.equal(
      s.result.buildId,
      version === "baseline" ? cohort.baselineBuild : cohort.candidateBuild,
    );
  }
for (let i = 1; i <= 3; i++) {
  const r = JSON.parse(await readFile(`${root}/cf-fenced-candidate-costs-${i}.json`, "utf8"));
  assert.equal(r.build, cohort.candidateBuild);
  assert.equal(r.completedGroups, r.groups);
  assert.equal(r.rows.length, 190);
}
assert.equal(
  execFileSync("git", ["diff", "2700b6d", "HEAD", "--", "src"], {
    cwd: worktree,
    encoding: "utf8",
  }),
  "",
);
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim(),
  plan.sourceCommit,
);
async function run(args, cwd) {
  const child = spawn(process.execPath, args, { cwd, stdio: "inherit" });
  const code = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  assert.equal(code, 0, args[0]);
}
await run(
  [
    "bench/deploy-public.mjs",
    "--config",
    `${root}/wrangler.jsonc`,
    "--secrets-file",
    "/tmp/cf-vfs-read-evaluation-secrets-20261014.json",
  ],
  worktree,
);
const generated = await readFile(`${worktree}/demo/benchmark-build.ts`, "utf8");
plan.build = generated.match(/"([a-f0-9]{64})"/u)?.[1];
assert.ok(plan.build);
plan.deploymentCompletedAt = new Date().toISOString();
await writeFile(`${root}/cf-private-calibration-plan.json`, JSON.stringify(plan, null, 2) + "\n");
for (const group of [1, 2])
  await run([`${root}/fenced-health.mjs`, String(group), "--calibration"]);
for (let i = 1; i <= plan.runs; i++) {
  const output = `${root}/cf-private-calibration-full-${i}.json`;
  await assertUnused(output);
  await run([
    "bench/public-remote.mjs",
    "--url",
    cohort.url,
    "--build",
    plan.build,
    "--out",
    output,
  ]);
}
await run([`${root}/assess-cf-fenced.mjs`, "--calibration"]);

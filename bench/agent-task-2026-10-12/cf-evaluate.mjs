import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const [base, build, label, resume] = process.argv.slice(2);
assert.ok(resume === undefined || resume === "resume-full-3");
assert.ok(base?.startsWith("https://"));
assert.match(build ?? "", /^[a-f0-9]{64}$/u);
assert.match(label ?? "", /^[a-z0-9-]+$/u);
const root = "bench/agent-task-2026-10-12";
async function run(args) {
  const child = spawn(process.execPath, args, { stdio: "inherit" });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0, `Failed: ${args[0]}`);
}
for (const kind of ["task", "full"]) {
  if (resume && kind === "task") continue;
  for (let i = resume ? 3 : 1; i <= 3; i++) {
    console.log(`Starting ${label} ${kind} ${i}/3`);
    await run([
      "bench/public-remote.mjs",
      "--url",
      base,
      "--build",
      build,
      ...(kind === "task" ? ["--task"] : []),
      "--out",
      `${root}/cf-${label}-${kind}-candidate-${i}.json`,
    ]);
  }
}
await run([`${root}/costs.mjs`, base, build, `${root}/cf-${label}-costs.json`]);
await run([`${root}/assess-cf.mjs`, label]);
for (let i = 1; i <= 2; i++) {
  console.log(`Starting ${label} full confirmation ${i}/2`);
  await run([
    "bench/public-remote.mjs",
    "--url",
    base,
    "--build",
    build,
    "--out",
    `${root}/cf-${label}-full-confirmation-${i}.json`,
  ]);
}
await run([`${root}/assess-confirmation.mjs`, label]);

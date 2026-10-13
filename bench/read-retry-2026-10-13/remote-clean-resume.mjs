import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const root = "bench/read-retry-2026-10-13";
const { versions } = JSON.parse(await readFile(root + "/cf-clean-plan.json", "utf8"));
async function run(args) {
  const child = spawn(process.execPath, args, { stdio: "inherit" });
  const code = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  if (code !== 0) throw Error("Failed " + args[0] + ": " + code);
}
const baseline = versions[0],
  candidate = versions[1];
for (let i = 2; i <= 3; i++)
  await run([
    "bench/public-remote.mjs",
    "--url",
    baseline.url,
    "--build",
    baseline.build,
    "--task",
    "--out",
    `${root}/cf-clean-baseline-task-${i}.json`,
  ]);
for (const kind of ["full", "task"])
  for (let i = 1; i <= candidate[kind]; i++)
    await run([
      "bench/public-remote.mjs",
      "--url",
      candidate.url,
      "--build",
      candidate.build,
      ...(kind === "task" ? ["--task"] : []),
      "--out",
      `${root}/cf-clean-candidate-${kind}-${i}.json`,
    ]);
for (let i = 1; i <= 3; i++)
  await run([
    "bench/agent-task-2026-10-12/costs.mjs",
    candidate.url,
    candidate.build,
    `${root}/cf-clean-candidate-costs-${i}.json`,
  ]);

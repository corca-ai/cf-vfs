import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const root = "bench/read-retry-2026-10-13";
const versions = [
  {
    name: "baseline",
    url: "https://vfs.borca.ai",
    build: "6202f9e15d94839fc9e38617cad41db18a0aec1f54d93914e5572f539d2c0607",
    full: 3,
    task: 3,
  },
  {
    name: "candidate",
    url: "https://cf-vfs-read-evaluation-20261014.donghun.workers.dev",
    build: "95ea59dd1e5f8dcb3885c1d1870295ed5977a4f9c0ca5162f5b89056049b7763",
    full: 5,
    task: 3,
  },
];
await writeFile(
  root + "/cf-clean-plan.json",
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      versions,
      logging:
        "No live tail or dashboard logs. Deployment and instrumentation unchanged throughout cohort.",
      metric:
        "Equal-weight uncached overall geometric mean; all families, per-workload and SQL gates required",
      confirmation:
        "Candidate full runs 4-5 are preselected independent confirmations; all five retained",
      failures:
        "Stop on server failure. GET transport retries resume same run; never retry lost POST automatically. Excluded instrumented runs retained separately.",
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
async function run(args) {
  const child = spawn(process.execPath, args, { stdio: "inherit" });
  const code = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  if (code !== 0) throw Error("Failed " + args[0] + ": " + code);
}
for (const v of versions) {
  for (const kind of ["full", "task"])
    for (let i = 1; i <= v[kind]; i++)
      await run([
        "bench/public-remote.mjs",
        "--url",
        v.url,
        "--build",
        v.build,
        ...(kind === "task" ? ["--task"] : []),
        "--out",
        `${root}/cf-clean-${v.name}-${kind}-${i}.json`,
      ]);
  if (v.name === "candidate")
    for (let i = 1; i <= 3; i++)
      await run([
        "bench/agent-task-2026-10-12/costs.mjs",
        v.url,
        v.build,
        `${root}/cf-clean-candidate-costs-${i}.json`,
      ]);
}

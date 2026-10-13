import { spawn } from "node:child_process";

const root = "bench/read-retry-2026-10-13";
const base = "https://cf-vfs-read-evaluation-20261014.donghun.workers.dev",
  build = "1aff96cad4f4e18164af8e0e2329346b7ce9a8abf3e131640b883866920ea9fa";
async function run(args) {
  const c = spawn(process.execPath, args, { stdio: "inherit" });
  const code = await new Promise((r, j) => {
    c.once("exit", r);
    c.once("error", j);
  });
  if (code !== 0) throw Error("Failed " + args[0] + ": " + code);
}
for (let i = 1; i <= 3; i++)
  await run([
    "bench/public-remote.mjs",
    "--url",
    base,
    "--build",
    build,
    "--task",
    "--out",
    root + "/cf-guarded-task-" + i + ".json",
  ]);
for (let i = 1; i <= 5; i++)
  await run([
    "bench/public-remote.mjs",
    "--url",
    base,
    "--build",
    build,
    "--out",
    root + "/cf-guarded-full-" + i + ".json",
  ]);
for (let i = 1; i <= 3; i++)
  await run([
    "bench/agent-task-2026-10-12/costs.mjs",
    base,
    build,
    root + "/cf-guarded-costs-" + i + ".json",
  ]);

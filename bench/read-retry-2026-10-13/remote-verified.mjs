import { spawn } from "node:child_process";

const root = "bench/read-retry-2026-10-13";
const base = "https://cf-vfs-read-evaluation-20261014.donghun.workers.dev",
  build = "95ea59dd1e5f8dcb3885c1d1870295ed5977a4f9c0ca5162f5b89056049b7763";
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
    root + "/cf-verified-task-" + i + ".json",
  ]);
for (let i = 1; i <= 5; i++)
  await run([
    "bench/public-remote.mjs",
    "--url",
    base,
    "--build",
    build,
    "--out",
    root + "/cf-verified-full-" + i + ".json",
  ]);
for (let i = 1; i <= 3; i++)
  await run([
    "bench/agent-task-2026-10-12/costs.mjs",
    base,
    build,
    root + "/cf-verified-costs-" + i + ".json",
  ]);

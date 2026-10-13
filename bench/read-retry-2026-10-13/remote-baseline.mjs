import { spawn } from "node:child_process";

async function run(args) {
  const c = spawn(process.execPath, args, { stdio: "inherit" });
  const code = await new Promise((r, j) => {
    c.once("exit", r);
    c.once("error", j);
  });
  if (code !== 0) throw Error("Failed " + args[0] + ": " + code);
}
for (let i = 2; i <= 3; i++)
  await run([
    "bench/public-remote.mjs",
    "--out",
    "bench/read-retry-2026-10-13/cf-baseline-full-" + i + ".json",
  ]);
for (let i = 1; i <= 3; i++)
  await run([
    "bench/public-remote.mjs",
    "--task",
    "--out",
    "bench/read-retry-2026-10-13/cf-baseline-task-" + i + ".json",
  ]);

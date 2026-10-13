import { spawn } from "node:child_process";

const root = "bench/read-retry-2026-10-13";
const before = "/tmp/cf-vfs-read-retry-base-20261013",
  after = "/tmp/cf-vfs-read-retry-fenced-20261014";
async function run(args, env = {}) {
  const c = spawn(process.execPath, args, { stdio: "inherit", env: { ...process.env, ...env } });
  const code = await new Promise((r, j) => {
    c.once("exit", r);
    c.once("error", j);
  });
  if (code !== 0) throw Error("Failed " + args[0] + ": " + code);
}
for (let session = 1; session <= 3; session++)
  for (const mode of ["unbound", "bound"]) {
    const out = root + "/local-fenced-" + mode + "-" + session + ".json";
    await run(["bench/three-hour-2026-10-10/local-pairs.mjs", before, after, out], {
      FIXED_GIT_TIME: "1",
      PAIRS: "6",
      WARMUPS: "2",
      CREDENTIALS: mode === "bound" ? "demo" : "",
    });
    await run([
      "bench/agent-task-2026-10-12/assess-local.mjs",
      out,
      out.replace(".json", "-assessment.json"),
    ]);
  }
await run(
  ["bench/agent-task-2026-10-12/local.mjs", before, after, root + "/local-fenced-task.json"],
  { PAIRS: "30" },
);

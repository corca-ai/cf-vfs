import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const root = "bench/read-retry-2026-10-13";
async function run(args, env = {}) {
  const c = spawn(process.execPath, args, { stdio: "inherit", env: { ...process.env, ...env } });
  const code = await new Promise((r, j) => {
    c.once("exit", r);
    c.once("error", j);
  });
  if (code !== 0) throw Error("Failed " + args[0] + ": " + code);
}
for (const mode of ["unbound", "bound"]) {
  const a = JSON.parse(await readFile(root + "/local-fenced-" + mode + "-aggregate.json"));
  const out = root + "/local-fenced-" + mode + "-recheck.json";
  await run(
    [
      "bench/three-hour-2026-10-10/local-pairs.mjs",
      "/tmp/cf-vfs-read-retry-base-20261013",
      "/tmp/cf-vfs-read-retry-fenced-20261014",
      out,
    ],
    {
      FIXED_GIT_TIME: "1",
      PAIRS: "10",
      WARMUPS: "2",
      CREDENTIALS: mode === "bound" ? "demo" : "",
      BENCH_GROUPS: [...new Set([...a.groups, "coding-mixed:1000:false"])].join(","),
    },
  );
  await run([
    "bench/agent-task-2026-10-12/assess-local.mjs",
    out,
    out.replace(".json", "-assessment.json"),
  ]);
}

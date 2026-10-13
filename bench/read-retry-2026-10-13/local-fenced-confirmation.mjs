import { spawn } from "node:child_process";

const root = "bench/read-retry-2026-10-13",
  before = "/tmp/cf-vfs-read-retry-base-20261013";
async function run(args, env = {}) {
  const c = spawn(process.execPath, args, { stdio: "inherit", env: { ...process.env, ...env } });
  const code = await new Promise((r, j) => {
    c.once("exit", r);
    c.once("error", j);
  });
  if (code !== 0) throw Error("Failed " + args[0] + ": " + code);
}
for (const kind of ["confirmation", "aa"])
  for (let session = 1; session <= (kind === "aa" ? 1 : 2); session++)
    for (const mode of ["unbound", "bound"]) {
      const out = root + "/local-fenced-" + kind + "-" + mode + "-" + session + ".json";
      await run(
        [
          "bench/three-hour-2026-10-10/local-pairs.mjs",
          before,
          kind === "aa"
            ? "/tmp/cf-vfs-read-retry-aa-20261014"
            : "/tmp/cf-vfs-read-retry-fenced-20261014",
          out,
        ],
        {
          FIXED_GIT_TIME: "1",
          PAIRS: "10",
          WARMUPS: "2",
          CREDENTIALS: mode === "bound" ? "demo" : "",
          BENCH_GROUPS:
            "git:100:false,git-shell:100:false,coding-small:100:false,coding-mixed:1000:false",
        },
      );
      await run([
        "bench/agent-task-2026-10-12/assess-local.mjs",
        out,
        out.replace(".json", "-assessment.json"),
      ]);
    }

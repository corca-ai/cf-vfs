import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const root = "bench/read-retry-2026-10-13";
const modes = await Promise.all(
  ["unbound", "bound"].map(async (mode) => ({
    mode,
    groups: [
      ...new Set([
        ...JSON.parse(await readFile(`${root}/local-fenced-group-${mode}-aggregate.json`, "utf8"))
          .groups,
        "coding-mixed:1000:false",
      ]),
    ],
  })),
);
await writeFile(
  root + "/local-fenced-group-recheck-plan.json",
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      protocol: "local-group-v1",
      sessionsPerMode: 2,
      orderOffsets: [0, 1],
      pairs: 10,
      warmups: 2,
      modes,
      note: "All per-session/full >5% and cost flags plus 1000-file mixed-clone control; retain both fixed independent followups.",
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
async function run(args, env = {}) {
  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  const code = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  if (code !== 0) throw Error("Failed " + args[0] + ": " + code);
}
for (let session = 1; session <= 2; session++)
  for (const { mode, groups } of modes) {
    const out = `${root}/local-fenced-group-${mode}-recheck-${session}.json`;
    await run(
      [
        "bench/local-pairs.mjs",
        "/tmp/cf-vfs-read-retry-base-20261013",
        "/tmp/cf-vfs-read-retry-fenced-20261014",
        out,
      ],
      {
        FIXED_GIT_TIME: "1",
        ORDER_OFFSET: String(session - 1),
        PAIRS: "10",
        WARMUPS: "2",
        CREDENTIALS: mode === "bound" ? "demo" : "",
        BENCH_GROUPS: groups.join(","),
      },
    );
    await run([
      "bench/agent-task-2026-10-12/assess-local.mjs",
      out,
      out.replace(".json", "-assessment.json"),
    ]);
  }

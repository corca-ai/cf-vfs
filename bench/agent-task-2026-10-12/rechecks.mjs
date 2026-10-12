import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const [before, after] = process.argv.slice(2);
const root = "bench/agent-task-2026-10-12";
const selection = {};
for (const mode of ["bound", "unbound"]) {
  const raw = JSON.parse(
    await readFile(`${root}/local-whole-full-${mode}-assessment.json`, "utf8"),
  );
  const stages = [...raw.review, ...raw.costRegressions].map((row) => row.stage);
  const groups = [
    ...new Set([
      "git-shell:1000:false",
      "git-recovery:100:false",
      ...stages.map((s) => `${s.group}:${s.files}:${s.cache}`),
    ]),
  ];
  selection[mode] = groups;
  const output = `${root}/local-recheck-${mode}.json`;
  const child = spawn(
    process.execPath,
    ["bench/three-hour-2026-10-10/local-pairs.mjs", before, after, output],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        FIXED_GIT_TIME: "1",
        CREDENTIALS: mode === "bound" ? "demo" : "",
        PAIRS: "10",
        WARMUPS: "2",
        BENCH_GROUPS: groups.join(","),
      },
    },
  );
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`Local ${mode} recheck failed: ${code}`);
}
await writeFile(`${root}/local-recheck-selection.json`, `${JSON.stringify(selection, null, 2)}\n`);

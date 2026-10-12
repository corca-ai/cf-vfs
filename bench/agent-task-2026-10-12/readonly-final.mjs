import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const [before, source, after] = process.argv.slice(2);
const root = "bench/agent-task-2026-10-12";
async function run(args, env = {}) {
  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`Local verification failed: ${code}`);
}
await run([`${root}/compile.mjs`, source, after]);
for (const mode of ["unbound", "bound"]) {
  await run(
    [
      "bench/three-hour-2026-10-10/local-pairs.mjs",
      before,
      after,
      `${root}/local-readonly-final-${mode}.json`,
    ],
    {
      FIXED_GIT_TIME: "1",
      PAIRS: "30",
      WARMUPS: "2",
      CREDENTIALS: mode === "bound" ? "demo" : "",
    },
  );
  await run([
    `${root}/assess-local.mjs`,
    `${root}/local-readonly-final-${mode}.json`,
    `${root}/local-readonly-final-${mode}-assessment.json`,
  ]);
}
await run([`${root}/local.mjs`, before, after, `${root}/local-readonly-final-task.json`], {
  PAIRS: "30",
});
const selection = {};
for (const mode of ["unbound", "bound"]) {
  const assessments = await Promise.all(
    ["full", "final"].map(async (phase) =>
      JSON.parse(await readFile(`${root}/local-readonly-${phase}-${mode}-assessment.json`, "utf8")),
    ),
  );
  const stages = assessments.flatMap((value) =>
    [...value.review, ...value.costRegressions].map((row) => row.stage),
  );
  const groups = [
    ...new Set([
      "files:100:false",
      "files:100:true",
      "coding-mixed:100:false",
      "git-shell:100:false",
      "git-shell:1000:false",
      "git:100:true",
      ...stages.map((stage) => `${stage.group}:${stage.files}:${stage.cache}`),
    ]),
  ];
  selection[mode] = groups;
  await run(
    [
      "bench/three-hour-2026-10-10/local-pairs.mjs",
      before,
      after,
      `${root}/local-readonly-repeat-${mode}.json`,
    ],
    {
      FIXED_GIT_TIME: "1",
      PAIRS: "10",
      WARMUPS: "2",
      CREDENTIALS: mode === "bound" ? "demo" : "",
      BENCH_GROUPS: groups.join(","),
    },
  );
  await run([
    `${root}/assess-local.mjs`,
    `${root}/local-readonly-repeat-${mode}.json`,
    `${root}/local-readonly-repeat-${mode}-assessment.json`,
  ]);
}
await writeFile(
  `${root}/local-readonly-repeat-selection.json`,
  `${JSON.stringify(selection, null, 2)}\n`,
);

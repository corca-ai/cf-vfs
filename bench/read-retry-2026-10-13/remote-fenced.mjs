import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";

const root = "bench/read-retry-2026-10-13";
const plan = JSON.parse(await readFile(root + "/cf-fenced-plan.json", "utf8"));
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
  console.error("Stopping after collecting the active run; no further claims.");
});
async function run(args, output) {
  if (stopping) throw Error("Stopped before next measurement");
  for (const path of [output, `${output}.gz`, `${output}.claim.json`]) {
    await access(path).then(
      () => {
        throw Error("Refusing to overwrite " + path);
      },
      (error) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
  }
  const child = spawn(process.execPath, args, { stdio: "inherit" });
  const code = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  if (code !== 0) throw Error("Failed " + args[0] + ": " + code);
  if (stopping) throw Error("Stopped after collecting active run");
}
async function timing(version, kind, index) {
  const baseline = version === "baseline",
    url = baseline ? "https://vfs.borca.ai" : plan.url,
    build = baseline ? plan.baselineBuild : plan.candidateBuild;
  const output = `${root}/cf-${baseline ? "clean" : "fenced"}-${version}-${kind}-${index}.json`;
  await run(
    [
      "bench/public-remote.mjs",
      "--url",
      url,
      "--build",
      build,
      ...(kind === "task" ? ["--task"] : []),
      "--out",
      output,
    ],
    output,
  );
}
for (let i = 1; i <= plan.candidateFullRuns; i++) await timing("candidate", "full", i);
for (let i = 1; i <= plan.candidateTaskInitialRuns; i++) await timing("candidate", "task", i);
for (let i = 1; i <= plan.costAudits; i++) {
  const output = `${root}/cf-fenced-candidate-costs-${i}.json`;
  await run(
    ["bench/agent-task-2026-10-12/costs.mjs", plan.url, plan.candidateBuild, output],
    output,
  );
}
for (const item of plan.extraTaskOrder) {
  const [version, kind, index] = item.split("-");
  await timing(version, kind, index);
}

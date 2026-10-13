import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";

const root = "bench/read-retry-2026-10-13";
const { versions } = JSON.parse(await readFile(root + "/cf-clean-plan.json", "utf8"));
const plan = JSON.parse(await readFile(root + "/cf-clean-task-confirmation-plan.json", "utf8"));
for (const item of plan.order) {
  const [version, , index] = item.split("-"),
    v = versions.find((v) => v.name === version);
  const output = `${root}/cf-clean-${version}-task-${index}.json`;
  await access(output).then(
    () => {
      throw Error("Refusing to overwrite " + output);
    },
    (error) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  const child = spawn(
    process.execPath,
    ["bench/public-remote.mjs", "--url", v.url, "--build", v.build, "--task", "--out", output],
    { stdio: "inherit" },
  );
  const code = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  if (code !== 0) throw Error("Failed task confirmation " + item + ": " + code);
}

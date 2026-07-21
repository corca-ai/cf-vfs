import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const fixtureUrl = new URL("../test/fixtures/bash-compat.json", import.meta.url);
const fixtures = JSON.parse(await readFile(fixtureUrl, "utf8"));

async function run(fixture) {
  const child = spawn("docker", [
    "run", "--rm", "-i",
    "-e", `LC_ALL=${fixtures.locale}`,
    "-e", `TZ=${fixtures.timezone}`,
    ...Object.entries(fixture.env).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
    fixtures.image,
    "--noprofile", "--norc", "-s", "--", ...fixture.args,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(`${fixture.script}\n`);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const normalizedStderr = stderr.replace(/^bash: line [0-9]+: /gmu, "");
  const { stderr: _previousStderr, ...fixtureWithoutOutput } = fixture;
  return {
    ...fixtureWithoutOutput,
    stdout,
    exitCode,
    ...(normalizedStderr === "" ? {} : { stderr: normalizedStderr }),
  };
}

fixtures.cases = await Promise.all(fixtures.cases.map(run));
await writeFile(fixtureUrl, `${JSON.stringify(fixtures, null, 2)}\n`);
console.log(`regenerated ${fixtures.cases.length} fixtures with ${fixtures.image}`);

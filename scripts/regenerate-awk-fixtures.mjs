import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const fixtureUrl = new URL("../test/fixtures/awk-compat.json", import.meta.url);
const fixtures = JSON.parse(await readFile(fixtureUrl, "utf8"));

async function run(argv, input) {
  const child = spawn("docker", ["run", "--rm", "-i", fixtures.digest, "awk", ...argv], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(input);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { stdout, stderr, exitCode };
}

for (const fixture of fixtures.cases) {
  const result = await run(fixture.args, fixture.input);
  if (result.stderr !== "") {
    throw new Error(`${fixture.name} wrote to stderr on the AWK oracle:\n${result.stderr}`);
  }
  fixture.stdout = result.stdout;
  fixture.exitCode = result.exitCode;
}

await writeFile(fixtureUrl, `${JSON.stringify(fixtures, null, 2)}\n`);
console.log(`regenerated ${fixtures.cases.length} AWK fixtures with ${fixtures.image}`);

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

// Regenerates `test/fixtures/jq-compat.json` from the pinned jq image. Unlike
// the utility oracles this image carries no shell — jq is its entry point — so
// a case is an argument vector and an input rather than a script.
const fixtureUrl = new URL("../test/fixtures/jq-compat.json", import.meta.url);
const fixtures = JSON.parse(await readFile(fixtureUrl, "utf8"));

async function run(argv, input) {
  const child = spawn(
    "docker",
    ["run", "--rm", "-i", "--user", "1000:1000", "-e", `LC_ALL=${fixtures.locale}`, fixtures.image, ...argv],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  // The async `execFile` has no `input` option — that belongs to the
  // synchronous form — so the stream is written here. Without this the oracle
  // waits on standard input and the run never returns.
  child.stdin.end(input);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { stdout, stderr, exitCode };
}

const digest = (
  await run(["--version"], "").then(() => resolveDigest())
).trim();

async function resolveDigest() {
  const child = spawn("docker", ["inspect", fixtures.image, "--format", "{{index .RepoDigests 0}}"]);
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    out += chunk;
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return out;
}

const regenerated = [];
for (const fixture of fixtures.cases) {
  const result = await run(fixture.args, fixture.input);
  if (result.stderr !== "" && fixture.expectStderr !== true) {
    throw new Error(`${fixture.name} wrote to stderr on the oracle: ${result.stderr}`);
  }
  const { stdout: _out, exitCode: _code, ...rest } = fixture;
  regenerated.push({ ...rest, stdout: result.stdout, exitCode: result.exitCode });
  process.stdout.write(`  ${fixture.name}\n`);
}

await writeFile(
  fixtureUrl,
  `${JSON.stringify({ ...fixtures, digest, cases: regenerated }, null, 2)}\n`,
);
console.log(`regenerated ${regenerated.length} jq fixtures with ${fixtures.image}`);

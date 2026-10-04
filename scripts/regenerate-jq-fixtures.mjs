import { execFileSync, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

// Real jq runs only in this explicitly invoked developer tool, never in tests.
const fixtureUrl = new URL("../test/fixtures/jq-compat.json", import.meta.url);
const recorded = await readFile(fixtureUrl, "utf8");
const fixtures = JSON.parse(recorded);
const check = process.argv.slice(2);
if (check.some((argument) => argument !== "--check")) throw new Error("usage: regenerate-jq-fixtures.mjs [--check]");
if (!/^ghcr\.io\/jqlang\/jq@sha256:[0-9a-f]{64}$/u.test(fixtures.digest)) {
  throw new Error("jq oracle requires a pinned image digest");
}

// Pull separately so Docker progress cannot become recorded jq diagnostics.
try {
  execFileSync("docker", ["image", "inspect", fixtures.digest], { stdio: "ignore" });
} catch {
  execFileSync("docker", ["pull", fixtures.digest], { stdio: "inherit" });
}

async function run(argv, input) {
  const child = spawn("docker", [
    "run", "--pull", "never", "--rm", "-i", "--user", "1000:1000", "-e", `LC_ALL=${fixtures.locale}`,
    fixtures.digest, ...argv,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  // Docker can exit before consuming input, e.g. when its daemon is unavailable.
  child.stdin.on("error", (error) => { if (error.code !== "EPIPE") child.destroy(error); });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal !== null || code === null) reject(new Error(`oracle terminated: ${signal}`));
      else resolve(code);
    });
    child.stdin.end(input);
  });
  return { stdout, stderr, exitCode };
}

const version = await run(["--version"], "");
if (version.exitCode !== 0 || version.stderr !== "") throw new Error(`jq oracle failed: ${version.stderr}`);
const cases = [];
for (const fixture of fixtures.cases) {
  const result = await run(fixture.args, fixture.input);
  // jq uses statuses 0–5; 125–127 indicate Docker/entry-point failures.
  if (result.exitCode > 5) throw new Error(`${fixture.name}: oracle failed: ${result.stderr}`);
  const { stdout: _out, stderr: _err, exitCode: _code, expectStderr: _expect, ...definition } = fixture;
  cases.push({ ...definition, ...result });
  process.stdout.write(`  ${fixture.name}\n`);
}
const regenerated = `${JSON.stringify({ ...fixtures, version: version.stdout.trim(), cases }, null, 2)}\n`;
if (check.includes("--check")) {
  if (!isDeepStrictEqual(JSON.parse(regenerated), fixtures)) throw new Error("jq fixtures differ from the pinned oracle; regenerate and review the diff");
  console.log(`verified ${cases.length} jq fixtures against ${fixtures.digest}`);
} else {
  await writeFile(fixtureUrl, regenerated);
  console.log(`regenerated ${cases.length} jq fixtures against ${fixtures.digest}`);
}

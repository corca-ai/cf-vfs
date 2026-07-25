import { spawn } from "node:child_process";
import { readFile, writeFile as writeHostFile } from "node:fs/promises";

// Regenerates `test/fixtures/utility-compat.json` from pinned BusyBox and GNU
// oracle images. The images are development and CI oracles only: nothing here
// ships, and the runtime never executes an external binary.
//
// Every case must succeed with empty stderr on the oracle. Diagnostics are
// explicitly outside the compatibility profile, so a case that writes to stderr
// would silently weaken the claim the fixtures make; the generator refuses it
// and the difference belongs in the `divergences` registry instead.

const WORKDIR = "/tmp/cf-vfs-fixture";
const fixtureUrl = new URL("../test/fixtures/utility-compat.json", import.meta.url);
const fixtures = JSON.parse(await readFile(fixtureUrl, "utf8"));

// Contents travel as base64 so a fixture can pin an unterminated final record,
// a NUL-free control character, or any quoting the oracle shell would mangle.
function writeFile(path, content) {
  const encoded = Buffer.from(content, "utf8").toString("base64");
  return `printf '%s' '${encoded}' | base64 -d > '${path}'\n`;
}

function program(fixture) {
  let text = `rm -rf ${WORKDIR}\nmkdir -p ${WORKDIR}\ncd ${WORKDIR} || exit 99\n`;
  for (const [path, content] of Object.entries(fixture.files ?? {})) {
    if (!/^[A-Za-z0-9._-]+$/u.test(path)) throw new Error(`unsupported fixture file name ${path}`);
    text += writeFile(path, content);
  }
  text += writeFile(".cf-vfs-stdin", fixture.stdin ?? "");
  return `${text}{\n${fixture.script}\n} < .cf-vfs-stdin\n`;
}

async function dockerRun(image, argv, input) {
  const child = spawn(
    "docker",
    ["run", "--rm", "-i", "-e", `LC_ALL=${fixtures.locale}`, "-e", `TZ=${fixtures.timezone}`, image, ...argv],
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
  child.stdin.end(input);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { stdout, stderr, exitCode };
}

async function imageDigest(image) {
  const child = spawn("docker", ["image", "inspect", "--format", "{{index .RepoDigests 0}}", image]);
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) throw new Error(`could not inspect ${image}`);
  return stdout.trim();
}

for (const [name, oracle] of Object.entries(fixtures.oracles)) {
  await dockerRun(oracle.image, [oracle.shell, "-c", "true"], "");
  oracle.digest = await imageDigest(oracle.image);
  const versions = {};
  for (const [label, command] of Object.entries(oracle.probe)) {
    const probe = await dockerRun(oracle.image, [oracle.shell, "-c", command], "");
    const line = probe.stdout.split("\n", 1)[0]?.trim() ?? "";
    if (line === "") throw new Error(`${label} version probe produced no output`);
    versions[label] = line;
  }
  oracle.versions = versions;
  console.log(`${name}: ${oracle.image} ${oracle.digest}`);
}

const regenerated = [];
for (const fixture of fixtures.cases) {
  const oracle = fixtures.oracles[fixture.oracle];
  if (oracle === undefined) throw new Error(`${fixture.name} names unknown oracle ${fixture.oracle}`);
  const result = await dockerRun(oracle.image, [oracle.shell, "-s"], program(fixture));
  if (result.stderr !== "") {
    throw new Error(`${fixture.name} wrote to stderr on the oracle:\n${result.stderr}`);
  }
  const { stdout: _stdout, exitCode: _exitCode, ...authored } = fixture;
  regenerated.push({ ...authored, stdout: result.stdout, exitCode: result.exitCode });
}
fixtures.cases = regenerated;

await writeHostFile(fixtureUrl, `${JSON.stringify(fixtures, null, 2)}\n`);
console.log(`regenerated ${fixtures.cases.length} utility fixtures`);

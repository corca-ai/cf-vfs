import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { measurePairs } from "./comparison.mjs";
import { createTextSuite, workloadNames } from "./text-suite.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const options = { base: "origin/main", warmups: 10, samples: 40, output: undefined };
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const key = args[index]?.slice(2);
  const value = args[index + 1];
  if (!args[index]?.startsWith("--") || !Object.hasOwn(options, key) || value === undefined) {
    throw new Error(
      "usage: bench:compare -- [--base REF] [--warmups N] [--samples N] [--output FILE]",
    );
  }
  options[key] = key === "warmups" || key === "samples" ? Number(value) : value;
}
if (
  !Number.isSafeInteger(options.warmups) ||
  options.warmups < 0 ||
  !Number.isSafeInteger(options.samples) ||
  options.samples < 2
) {
  throw new Error("warmups must be non-negative and samples must be at least two");
}
const git = (...arguments_) =>
  execFileSync("git", arguments_, { cwd: repository, encoding: "utf8" }).trim();
const baselineCommit = git("rev-parse", "--verify", `${options.base}^{commit}`);
const candidateCommit = git("rev-parse", "HEAD");
const trackedDiff = git(
  "diff",
  "HEAD",
  "--",
  "src",
  "tsconfig.build.json",
  "tsconfig.json",
  "package.json",
  "package-lock.json",
);
if (git("ls-files", "--others", "--exclude-standard", "src"))
  throw new Error("commit or stage new source files before comparing");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function compiledHash(root) {
  const files = (await readdir(root, { recursive: true }))
    .filter((file) => file.endsWith(".js"))
    .sort();
  const digest = createHash("sha256");
  for (const file of files) {
    digest
      .update(file)
      .update("\0")
      .update(await readFile(join(root, file)))
      .update("\0");
  }
  return digest.digest("hex");
}
const compiler = join(repository, "node_modules/typescript/bin/tsc");
const temporary = await mkdtemp(join(tmpdir(), "cf-vfs-compare-"));
const suites = {};
try {
  process.stderr.write(`Building baseline ${baselineCommit} and candidate ${candidateCommit}\n`);
  const archive = join(temporary, "baseline.tar");
  execFileSync("git", ["archive", "--output", archive, baselineCommit], { cwd: repository });
  execFileSync("tar", ["-xf", archive, "-C", temporary]);
  await symlink(join(repository, "node_modules"), join(temporary, "node_modules"), "dir");
  await rm(join(temporary, "dist"), { recursive: true, force: true });
  execFileSync(process.execPath, [compiler, "-p", join(temporary, "tsconfig.build.json")], {
    stdio: "inherit",
  });
  execFileSync("npm", ["run", "build"], {
    cwd: repository,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const baselineCompiledSha256 = await compiledHash(join(temporary, "dist"));
  const candidateCompiledSha256 = await compiledHash(join(repository, "dist"));
  const baselineLockSha256 = hash(await readFile(join(temporary, "package-lock.json")));
  const candidateLockSha256 = hash(await readFile(join(repository, "package-lock.json")));
  suites.baseline = await createTextSuite(pathToFileURL(`${temporary}/dist/`));
  suites.candidate = await createTextSuite(pathToFileURL(`${repository}/dist/`));
  const rows = [];
  for (const name of workloadNames) {
    process.stderr.write(`Measuring ${name}\n`);
    rows.push(await measurePairs(suites, name, options.warmups, options.samples));
  }
  const files = ["text-processing-cases.json", "text-suite.mjs", "comparison.mjs", "compare.mjs"];
  const protocol = await Promise.all(files.map((file) => readFile(new URL(file, import.meta.url))));
  const report = {
    baseline: {
      ref: options.base,
      commit: baselineCommit,
      compiledSha256: baselineCompiledSha256,
      lockSha256: baselineLockSha256,
    },
    candidate: {
      commit: candidateCommit,
      compiledSha256: candidateCompiledSha256,
      lockSha256: candidateLockSha256,
      dirty: trackedDiff !== "",
      trackedDiffSha256: hash(trackedDiff),
    },
    toolchain: {
      node: process.version,
      typescript: JSON.parse(
        await readFile(join(repository, "node_modules/typescript/package.json"), "utf8"),
      ).version,
    },
    machine: { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
    protocol: {
      warmups: options.warmups,
      samples: options.samples,
      order: "alternating AB/BA",
      sameProcess: true,
      sha256: hash(Buffer.concat(protocol)),
      command: ["npm", "run", "bench:compare", "--", ...args],
    },
    identicalCompiledCode: baselineCompiledSha256 === candidateCompiledSha256,
    rows,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) await writeFile(resolve(options.output), json);
  else process.stdout.write(json);
} finally {
  for (const suite of Object.values(suites)) suite.close();
  await rm(temporary, { recursive: true, force: true });
}

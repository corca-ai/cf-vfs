/** Rebuild a chosen baseline and replay the five isolated experiments locally. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const options = { base: "HEAD", output: "/tmp/cf-vfs-fs-evaluation", trials: 3 };
for (let i = 0; i < args.length; i += 2) {
  const key = args[i]?.slice(2),
    value = args[i + 1];
  if (!Object.hasOwn(options, key) || value === undefined)
    throw new Error("usage: --base REF --output DIRECTORY --trials N");
  options[key] = key === "trials" ? Number(value) : value;
}
if (!Number.isSafeInteger(options.trials) || options.trials < 1)
  throw new Error("trials must be positive");
const run = (program, args, cwd = repository) =>
  execFileSync(program, args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const baseline = run("git", ["rev-parse", `${options.base}^{commit}`]).trim();
const temporary = await mkdtemp(path.join(tmpdir(), "cf-vfs-fs-evaluation-"));
const destination = path.resolve(options.output);
await mkdir(destination, { recursive: true });
const compiler = path.join(repository, "node_modules/typescript/bin/tsc");
const build = (root) =>
  run(process.execPath, [compiler, "-p", path.join(root, "tsconfig.build.json")]);
const strip = (result) => {
  for (const row of result.results) {
    row.topQueries = undefined;
    row.fsCallMs = undefined;
    row.failures = undefined;
  }
  return result;
};
async function sourceHash(directory) {
  const digest = createHash("sha256");
  for (const file of (await readdir(directory, { recursive: true }))
    .filter((p) => p.endsWith(".ts"))
    .sort()) {
    digest
      .update(file)
      .update("\0")
      .update(await readFile(path.join(directory, file)));
  }
  return digest.digest("hex");
}
try {
  const archive = path.join(temporary, "baseline.tar");
  run("git", ["archive", "--output", archive, baseline]);
  const base = path.join(temporary, "baseline");
  await mkdir(base);
  run("tar", ["-xf", archive, "-C", base]);
  await symlink(path.join(repository, "node_modules"), path.join(base, "node_modules"), "dir");
  // The optional adapter is the same in each experiment; baseline does not use it.
  await cp(path.join(repository, "src/fs"), path.join(base, "src/fs"), {
    recursive: true,
    force: true,
  });
  build(base);
  const libraries = {};
  for (const variant of ["bytes", "batch"]) {
    const directory = path.join(temporary, variant);
    await mkdir(directory);
    for (const file of [
      "src",
      "tsconfig.json",
      "tsconfig.build.json",
      "package.json",
      "worker-configuration.d.ts",
    ]) {
      await cp(path.join(base, file), path.join(directory, file), { recursive: true });
    }
    await symlink(
      path.join(repository, "node_modules"),
      path.join(directory, "node_modules"),
      "dir",
    );
    const patch =
      variant === "bytes" ? "byte-sync.rejected.patch" : "batch-parent-cache.rejected.patch";
    run("git", ["apply", path.join(repository, "bench/fs-evaluation", patch)], directory);
    build(directory);
    libraries[variant] = path.join(directory, "dist");
  }
  run("npm", ["run", "build"]);
  const candidate = path.join(temporary, "candidate");
  await cp(path.join(repository, "dist"), candidate, { recursive: true });
  const manifest = {
    baselineCommit: baseline,
    candidateSourceSha256: await sourceHash(path.join(repository, "src")),
    node: process.version,
    trials: options.trials,
  };
  for (const variant of ["baseline", "metadata", "bytes", "batch", "fs", "tiered", "combined"]) {
    const library =
      variant === "combined" ? candidate : libraries[variant] || path.join(base, "dist");
    const output = path.join(destination, `${variant}.json`);
    process.stderr.write(`Measuring ${variant}\n`);
    execFileSync(process.execPath, ["bench/git-workload.mjs"], {
      cwd: repository,
      stdio: "pipe",
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_PROBE_VARIANT: variant,
        GIT_PROBE_LIBRARY: library,
        GIT_PROBE_TRIALS: String(options.trials),
        GIT_PROBE_OUTPUT: output,
      },
    });
    const result = strip(JSON.parse(await readFile(output, "utf8")));
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
    if (["baseline", "bytes", "batch"].includes(variant)) {
      execFileSync(process.execPath, ["bench/fs-primitives.mjs"], {
        cwd: repository,
        stdio: "pipe",
        env: {
          ...process.env,
          GIT_PROBE_VARIANT: variant,
          GIT_PROBE_LIBRARY: library,
          GIT_PROBE_OUTPUT: path.join(destination, `${variant}-primitives.json`),
        },
      });
    }
  }
  const reentrant = {};
  for (const variant of ["baseline", "batch"])
    reentrant[variant] = JSON.parse(
      run(process.execPath, [
        "bench/fs-evaluation/batch-reentrancy.mjs",
        libraries[variant] || path.join(base, "dist"),
      ]),
    );
  manifest.batchReentrancy = reentrant;
  await writeFile(
    path.join(destination, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  process.stderr.write(`Saved measurements to ${destination}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

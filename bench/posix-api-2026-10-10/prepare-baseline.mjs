import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const scratch = await mkdtemp(resolve(tmpdir(), "cf-vfs-posix-api-baseline-"));
try {
  const tar = resolve(scratch, "source.tar");
  await exec("git", [
    "archive",
    "--format=tar",
    `--output=${tar}`,
    "6ced964",
    "src",
    "tsconfig.json",
    "tsconfig.build.json",
  ]);
  await exec("tar", ["-xf", tar, "-C", scratch]);
  await writeFile(resolve(scratch, "package.json"), '{"type":"module"}\n');
  await symlink(resolve("node_modules"), resolve(scratch, "node_modules"), "dir");
  await exec(resolve("node_modules/.bin/tsc"), ["-p", resolve(scratch, "tsconfig.build.json")]);
  const out = resolve("bench/posix-api-2026-10-10/baseline");
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(resolve(scratch, "dist"), out, { recursive: true });
  await symlink(resolve("node_modules"), resolve(out, "node_modules"), "dir");
  console.log("Prepared baseline 6ced964 in", out);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

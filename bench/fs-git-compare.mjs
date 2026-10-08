/** Alternate fresh baseline/candidate Git runs without concurrent build work. */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
if (!process.env.FS_BASELINE) throw new Error("set FS_BASELINE to a compiled baseline dist");
const temporary = await mkdtemp(path.join(tmpdir(), "cf-vfs-git-pairs-"));
const measurements = [];
try {
  for (let pair = 0; pair < 4; pair++) {
    const order = pair % 2 === 0 ? ["baseline", "combined"] : ["combined", "baseline"];
    for (const variant of order) {
      const output = path.join(temporary, `${pair}-${variant}.json`);
      execFileSync(process.execPath, ["bench/git-workload.mjs"], {
        cwd: repository,
        stdio: "pipe",
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_PROBE_VARIANT: variant,
          GIT_PROBE_LIBRARY:
            variant === "baseline"
              ? path.resolve(process.env.FS_BASELINE)
              : path.resolve(process.env.FS_CANDIDATE || "dist"),
          GIT_PROBE_COUNTS: "1000",
          GIT_PROBE_TRIALS: "1",
          GIT_PROBE_OUTPUT: output,
        },
      });
      const result = JSON.parse(await readFile(output, "utf8"));
      for (const row of result.results) {
        row.topQueries = undefined;
        row.failures = undefined;
        row.fsCallMs = undefined;
      }
      measurements.push({ pair, variant, ...result });
    }
  }
  await writeFile(
    process.env.FS_COMPARE_OUTPUT || "/tmp/cf-vfs-git-paired.json",
    `${JSON.stringify(measurements, null, 2)}\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

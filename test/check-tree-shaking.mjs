import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const outputDirectory = await mkdtemp(join(tmpdir(), "cloudflare-vfs-tree-shake-"));

try {
  await execFileAsync(
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
    ["deploy", "--dry-run", "--config", "wrangler.tree-shake.jsonc", "--outdir", outputDirectory],
    { cwd: new URL("..", import.meta.url) },
  );
  const files = await readdir(outputDirectory);
  const workerFile = files.find((file) => file.endsWith(".js"));
  if (!workerFile) throw new Error("Wrangler did not emit a JavaScript worker bundle");
  const bundle = await readFile(join(outputDirectory, workerFile), "utf8");
  for (const excluded of ["regex search requires an explicit RegexEngine", "binary files cannot be modified"]) {
    if (bundle.includes(excluded)) {
      throw new Error(`ls-only bundle unexpectedly contains: ${excluded}`);
    }
  }
  console.log(`tree-shaking verified (${Buffer.byteLength(bundle)} byte ls-only bundle)`);
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}

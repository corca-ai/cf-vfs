import { spawnSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const output = "/tmp/cf-coding-build";
const compile = spawnSync(
  "npx",
  [
    "tsc",
    "--ignoreConfig",
    "--module",
    "nodenext",
    "--moduleResolution",
    "nodenext",
    "--target",
    "es2022",
    "--skipLibCheck",
    "--types",
    "node,@cloudflare/workers-types",
    "--outDir",
    output,
    "--rootDir",
    ".",
    "demo/benchmark-git-workflow.ts",
    "demo/benchmark-git-recovery.ts",
    "src/testing/node.ts",
  ],
  { stdio: "inherit" },
);
if (compile.status !== 0) process.exit(compile.status ?? 1);
await mkdir(output, { recursive: true });
await writeFile(`${output}/package.json`, '{"type":"module"}\n');
try {
  await symlink(`${process.cwd()}/node_modules`, `${output}/node_modules`);
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
const { NodeSqlFileSystem } = await import(pathToFileURL(`${output}/src/testing/node.js`));
const { GitCodingWorkflow, WORKFLOW_OPERATIONS } = await import(
  pathToFileURL(`${output}/demo/benchmark-git-workflow.js`)
);
const { RECOVERY_OPERATIONS, runGitRecovery } = await import(
  pathToFileURL(`${output}/demo/benchmark-git-recovery.js`)
);
const rows = [];
let verified = 0;
for (const files of [100, 1000])
  for (const mixed of [false, true]) {
    const samples = new Map(WORKFLOW_OPERATIONS.map((operation) => [operation, []]));
    for (let trial = -1; trial < 3; trial++) {
      const vfs = new NodeSqlFileSystem();
      try {
        const workflow = new GitCodingWorkflow(vfs, mixed);
        for (const operation of WORKFLOW_OPERATIONS) {
          const started = performance.now();
          await workflow.run(operation, files);
          const elapsed = performance.now() - started;
          if (trial >= 0) samples.get(operation).push(elapsed);
          if (["clone", "commit-partial", "checkout-base", "checkout-main"].includes(operation))
            verified += await workflow.validate(operation, files);
        }
      } finally {
        vfs.close();
      }
    }
    for (const [operation, samplesMs] of samples)
      rows.push({
        group: mixed ? "coding-mixed" : "coding-small",
        files,
        operation,
        samplesMs,
        medianMs: [...samplesMs].sort((a, b) => a - b)[1],
      });
  }
const recovery = [];
for (const operation of RECOVERY_OPERATIONS) {
  const vfs = new NodeSqlFileSystem();
  try {
    recovery.push({ operation, ...(await runGitRecovery(vfs, operation)) });
  } finally {
    vfs.close();
  }
}
await writeFile(
  new URL("local.json", import.meta.url),
  JSON.stringify(
    {
      node: process.version,
      measurement:
        "Node SQLite VFS + shell applet; one warmup and three sequential samples; full-body validation excluded",
      rows,
      recovery,
      verified,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Saved ${rows.length} workflow rows, ${recovery.length} recovery scenarios, ${verified} byte/history/path checks`,
);

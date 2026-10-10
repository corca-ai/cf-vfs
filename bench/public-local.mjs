import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const root = resolve(option("--root") ?? ".");
const output = option("--out");
const temporary = await mkdtemp(join(tmpdir(), "vfs-public-local-"));
try {
  await writeFile(join(temporary, "package.json"), '{"type":"module"}');
  await symlink(resolve("node_modules"), join(temporary, "node_modules"), "dir");
  const config = join(temporary, "tsconfig.json");
  await writeFile(
    config,
    JSON.stringify({
      extends: join(root, "tsconfig.build.json"),
      compilerOptions: {
        rootDir: root,
        outDir: join(temporary, "compiled"),
        declaration: false,
        noEmit: false,
      },
      include: [join(root, "demo/benchmark-suite.ts"), join(root, "src/testing/node.ts")],
      exclude: [],
    }),
  );
  execFileSync(resolve("node_modules/.bin/tsc"), ["-p", config], { stdio: "inherit" });
  const { PublicBenchmarkSuite, benchmarkPlan, summarizeStage } = await import(
    pathToFileURL(join(temporary, "compiled/demo/benchmark-suite.js"))
  );
  const { NodeSqlFileSystem } = await import(
    pathToFileURL(join(temporary, "compiled/src/testing/node.js"))
  );
  let suite,
    statements = 0;
  const fs = new NodeSqlFileSystem({
    onEvent: (event) => suite?.onEvent(event),
    onStatement: () => statements++,
  });
  suite = new PublicBenchmarkSuite(fs);
  const samples = new Map();
  let verified = 0;
  try {
    for (const stage of benchmarkPlan()) {
      statements = 0;
      const start = performance.now();
      const outcome = await suite.run(stage);
      const duration = performance.now() - start;
      const sqlStatements = statements;
      verified += outcome.verified;
      const key = JSON.stringify([stage.group, stage.operation, stage.files, stage.cache]);
      if (stage.trial >= 0) {
        const saved = samples.get(key) ?? {
          stage,
          iterations: outcome.iterations,
          times: [],
          statements: [],
        };
        if (saved.iterations !== outcome.iterations) throw new Error("Iteration count changed");
        saved.times.push(duration);
        saved.statements.push(sqlStatements);
        samples.set(key, saved);
      }
      if (
        (["coding-small", "coding-mixed"].includes(stage.group) &&
          ["clone", "commit-partial", "checkout-base", "checkout-main"].includes(
            stage.operation,
          )) ||
        stage.operation === "remove-tree" ||
        stage.operation === "checkout-main" ||
        (stage.group === "git-shell" &&
          ["add-one", "add-changed", "add-removals"].includes(stage.operation))
      )
        verified += await suite.validate(stage);
    }
    await suite.cleanup();
    const result = {
      version: 1,
      commitHash: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      dirty:
        execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).trim() !==
        "",
      engine: `isomorphic-git ${JSON.parse(await readFile(resolve("node_modules/isomorphic-git/package.json"), "utf8")).version}`,
      measurement:
        "NodeSqlFileSystem full public plan; one warmup, three samples; in-process wall time including operation assertions and statement instrumentation; final body validation excluded",
      runId: `local-${Date.now()}`,
      completedAt: new Date().toISOString(),
      colo: null,
      verified,
      rows: [...samples.values()].map(({ stage, times, iterations, statements }) => ({
        ...summarizeStage(stage, times, iterations),
        sql: { statements: [...statements].sort((a, b) => a - b)[1] },
      })),
    };
    const text = `${JSON.stringify(result, null, 2)}\n`;
    if (output) await writeFile(output, text);
    else console.log(text);
    console.error(`Completed ${result.rows.length} workloads; ${verified} checks`);
  } finally {
    fs.close();
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}

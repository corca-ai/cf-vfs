import { execFileSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [source, output] = process.argv.slice(2).map((path) => resolve(path));
if (!source || !output) throw new Error("Usage: compile.mjs SOURCE NEW_OUTPUT_DIRECTORY");
await mkdir(output); // Refuse to overwrite an existing graph.
await symlink(resolve("node_modules"), `${output}/node_modules`, "dir");
await writeFile(`${output}/package.json`, '{"type":"module"}\n');
await writeFile(
  `${output}/tsconfig.json`,
  JSON.stringify(
    {
      extends: `${source}/tsconfig.build.json`,
      compilerOptions: {
        rootDir: source,
        outDir: output,
        module: "esnext",
        moduleResolution: "bundler",
        declaration: true,
        noEmit: false,
      },
      include: [
        `${source}/src/**/*.ts`,
        `${source}/demo/benchmark-suite.ts`,
        `${source}/demo/benchmark-agent-task.ts`,
      ],
      exclude: [],
    },
    null,
    2,
  ),
);
execFileSync(resolve("node_modules/.bin/tsc"), ["-p", `${output}/tsconfig.json`], {
  stdio: "inherit",
});

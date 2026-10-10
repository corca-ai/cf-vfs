import { execFileSync } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [source, target] = process.argv.slice(2).map((path) => resolve(path));
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await writeFile(join(target, "package.json"), '{"type":"module"}');
await symlink(resolve("node_modules"), join(target, "node_modules"), "dir");
const config = join(target, "tsconfig.json");
await writeFile(
  config,
  JSON.stringify({
    extends: join(source, "tsconfig.build.json"),
    compilerOptions: { rootDir: source, outDir: target, declaration: true, noEmit: false },
    include: [
      join(source, "demo/benchmark-suite.ts"),
      join(source, "src/testing/node.ts"),
      join(source, "src/vfs/do-sql.ts"),
    ],
    exclude: [],
  }),
);
execFileSync(resolve("node_modules/.bin/tsc"), ["-p", config], { stdio: "inherit" });

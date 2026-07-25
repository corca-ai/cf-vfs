import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repository = new URL("..", import.meta.url);
const budgetUrl = new URL("fixtures/bundle-budgets.json", import.meta.url);
const budgetFile = JSON.parse(await readFile(budgetUrl, "utf8"));
const { toleranceRatio, budgets } = budgetFile;
// `--record` rewrites the recorded budgets from this run so a deliberate size
// change lands as a reviewable diff rather than an edited constant.
const record = process.argv.includes("--record");

// Every preset states which library modules must and must not be reachable.
// The assertion runs against the bundle's source map, whose `sources` array is
// the exact module list esbuild kept — a claim no string search can defeat and
// that reworded comments or diagnostics cannot weaken.
const M = {
  applet: "shell/commands/applet",
  options: "shell/commands/options",
  helpers: "shell/commands/helpers",
  ls: "shell/commands/ls",
  core: "shell/commands/core",
  fs: "shell/commands/fs",
  text: "shell/commands/text",
  xargs: "shell/commands/xargs",
  registry: "shell/commands/default",
  discovery: "shell/commands/discovery",
  sh: "shell/commands/sh",
  help: "shell/commands/help",
  link: "shell/commands/link",
  sed: "shell/commands/sed",
  system: "shell/commands/system",
  posixRegex: "core/posix-regex",
  script: "shell/script",
  linux: "shell/linux",
  parser: "shell/parser",
  shell: "shell/shell",
  interactive: "shell/interactive",
  sql: "vfs/sql",
  doSql: "vfs/do-sql",
  r2: "storage/r2",
};

/**
 * Maps a source-map entry to a library module id, or `undefined` for the
 * fixture entry point. Every fixture imports through a package subpath, so all
 * library modules arrive as compiled `dist/` paths and every preset measures
 * the same compiler output.
 */
function moduleId(path) {
  const match = /(?:^|\/)dist\/(.+)\.js$/u.exec(path);
  return match === null ? undefined : match[1];
}

const PRESETS = [
  {
    name: "ls",
    config: "wrangler.tree-shake.jsonc",
    describe: "one applet imported from its own subpath",
    include: [M.ls, M.applet, M.options],
    exclude: [
      M.core,
      M.fs,
      M.text,
      M.xargs,
      M.discovery,
      M.sh,
      M.help,
      M.link,
      M.sed,
      M.system,
      M.posixRegex,
      M.registry,
      M.linux,
      M.parser,
      M.shell,
      M.script,
      M.interactive,
      M.sql,
    ],
  },
  {
    name: "commands",
    config: "wrangler.commands-tree-shake.jsonc",
    describe: "a small explicit registry of two applets",
    include: [M.fs, M.text, M.applet],
    exclude: [
      M.ls,
      M.core,
      M.xargs,
      M.discovery,
      M.sh,
      M.help,
      M.link,
      M.sed,
      M.system,
      M.registry,
      M.linux,
      M.parser,
      M.shell,
      M.script,
      M.interactive,
      M.sql,
      M.r2,
    ],
  },
  {
    name: "vfs",
    config: "wrangler.vfs-tree-shake.jsonc",
    describe: "the SQLite filesystem with no shell and no R2",
    include: [M.sql, M.doSql],
    exclude: [
      M.applet,
      M.helpers,
      M.core,
      M.fs,
      M.ls,
      M.text,
      M.discovery,
      M.sh,
      M.help,
      M.link,
      M.sed,
      M.system,
      M.linux,
      M.parser,
      M.shell,
      M.script,
      M.r2,
    ],
  },
  {
    name: "shell",
    config: "wrangler.shell-tree-shake.jsonc",
    describe: "the non-interactive shell with one applet",
    include: [M.shell, M.parser, M.applet, M.core],
    exclude: [
      M.interactive,
      M.fs,
      M.ls,
      M.text,
      M.xargs,
      M.discovery,
      M.sh,
      M.help,
      M.link,
      M.sed,
      M.system,
      M.registry,
      M.linux,
      M.sql,
      M.r2,
    ],
  },
  {
    name: "interactive",
    config: "wrangler.interactive-tree-shake.jsonc",
    describe: "the interactive session adapter",
    include: [M.shell, M.parser, M.interactive, M.core, M.script],
    exclude: [
      M.fs,
      M.ls,
      M.text,
      M.xargs,
      M.discovery,
      M.sh,
      M.help,
      M.link,
      M.sed,
      M.system,
      M.registry,
      M.linux,
      M.sql,
      M.r2,
    ],
  },
  {
    name: "default-registry",
    config: "wrangler.default-registry-tree-shake.jsonc",
    describe: "the convenience preset with every applet",
    include: [
      M.registry,
      M.core,
      M.fs,
      M.ls,
      M.text,
      M.xargs,
      M.discovery,
      M.sh,
      M.help,
      M.link,
      M.sed,
      M.system,
      M.shell,
      M.parser,
      M.script,
    ],
    exclude: [M.interactive, M.linux, M.sql, M.doSql, M.r2],
  },
  {
    name: "linux-profile",
    config: "wrangler.linux-profile-tree-shake.jsonc",
    describe: "the opt-in Linux profile over the SQLite filesystem",
    include: [
      M.linux,
      M.registry,
      M.discovery,
      M.sh,
      M.help,
      M.link,
      M.sed,
      M.shell,
      M.parser,
      M.sql,
      M.doSql,
    ],
    exclude: [M.interactive, M.r2],
  },
  {
    name: "r2-opaque",
    config: "wrangler.r2-opaque-tree-shake.jsonc",
    describe: "the SQLite filesystem with the R2 opaque adapter",
    include: [M.sql, M.doSql, M.r2],
    exclude: [
      M.applet,
      M.core,
      M.fs,
      M.ls,
      M.text,
      M.discovery,
      M.sh,
      M.help,
      M.link,
      M.sed,
      M.system,
      M.linux,
      M.parser,
      M.shell,
      M.script,
      M.interactive,
    ],
  },
];

// Artifacts rather than library modules, so these stay raw-text checks.
const FORBIDDEN_TEXT = ["node:sqlite", "dist/testing/"];

async function bundle(config) {
  const outputDirectory = await mkdtemp(join(tmpdir(), "cloudflare-vfs-tree-shake-"));
  try {
    await execFileAsync(
      process.platform === "win32" ? "wrangler.cmd" : "wrangler",
      ["deploy", "--dry-run", "--config", config, "--outdir", outputDirectory],
      { cwd: repository },
    );
    const files = await readdir(outputDirectory);
    const workerFile = files.find((file) => file.endsWith(".js"));
    if (!workerFile) throw new Error("Wrangler did not emit a JavaScript worker bundle");
    const mapFile = files.find((file) => file.endsWith(".js.map"));
    if (!mapFile) throw new Error("Wrangler did not emit a source map");
    const source = await readFile(join(outputDirectory, workerFile), "utf8");
    const { sources } = JSON.parse(await readFile(join(outputDirectory, mapFile), "utf8"));
    const modules = sources.map(moduleId).filter((id) => id !== undefined);
    if (modules.length === 0) {
      throw new Error(
        `${config} produced no library modules; the source map may have changed shape`,
      );
    }
    return { source, modules };
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

const measured = [];
const failures = [];
for (const preset of PRESETS) {
  const { source, modules } = await bundle(preset.config);
  const reachable = new Set(modules);
  for (const module of preset.include) {
    assert(reachable.has(module), `${preset.name} bundle is missing ${module}`);
  }
  for (const module of preset.exclude) {
    assert(!reachable.has(module), `${preset.name} bundle reaches ${module}`);
  }
  for (const text of FORBIDDEN_TEXT) {
    assert(!source.includes(text), `${preset.name} bundle contains ${text}`);
  }

  const bytes = Buffer.byteLength(source);
  if (record) {
    budgets[preset.name] = Math.ceil((bytes * 1.05) / 128) * 128;
    measured.push(`${preset.name} ${bytes} bytes recorded (${preset.describe})`);
    continue;
  }
  const budget = budgets[preset.name];
  assert(typeof budget === "number", `${preset.name} has no recorded bundle budget`);
  if (bytes > budget) {
    failures.push(`${preset.name} is ${bytes} bytes, over its ${budget}-byte budget`);
  } else if (bytes < budget * toleranceRatio) {
    failures.push(
      `${preset.name} is ${bytes} bytes, far under its ${budget}-byte budget; tighten the recorded budget`,
    );
  }
  measured.push(`${preset.name} ${bytes}/${budget} bytes (${preset.describe})`);
}

console.log(measured.map((line) => `  ${line}`).join("\n"));
if (record) {
  for (const name of Object.keys(budgets)) {
    if (!PRESETS.some((preset) => preset.name === name)) delete budgets[name];
  }
  await writeFile(budgetUrl, `${JSON.stringify(budgetFile, null, 2)}\n`);
  console.log(`recorded ${PRESETS.length} bundle budgets`);
} else {
  assert.deepEqual(failures, [], `bundle budgets:\n  ${failures.join("\n  ")}`);
  console.log(`tree-shaking and bundle budgets verified across ${PRESETS.length} presets`);
}

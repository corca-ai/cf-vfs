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

// Semantic markers. A byte budget alone cannot tell an unrelated applet from a
// slightly larger one, so every preset also states what must and must not be
// reachable.
//
// An applet marker is its declared summary, which lives in the same object
// literal as its runner: the summary survives exactly when the applet does.
// Diagnostics are no longer usable as markers because a usage message is now
// assembled from the specification name at runtime.
const APPLET_MARKERS = {
  ls: "lists directory entries or a single path",
  cat: "concatenates files, or standard input, to standard output",
  mkdir: "creates directories",
  find: "walks a subtree and prints matching paths",
  mktemp: "creates a uniquely named empty file",
  xargs: "runs a command once per batch of arguments read from standard input",
  seq: "prints an integer sequence",
  diff: "prints a unified difference between two files",
  patch: "applies a unified difference to a file",
  join: "joins two sorted files on a common field",
  grep: "prints records matching a pattern",
  file: "classifies a path as directory, inline data, or opaque content",
};
const PARSER = "shell AST node limit exceeded";
const REGISTRY = "command not found";
const OPAQUE_NAMESPACE = "opaque R2 content is not available to shell commands";
const R2_ADAPTER = "byte range must use offset/length or suffix";
const INTERACTIVE = "interactive shell is closed";
const NODE_SQLITE = "node:sqlite";

const PRESETS = [
  {
    name: "ls",
    config: "wrangler.tree-shake.jsonc",
    describe: "one applet imported from its own subpath",
    include: [APPLET_MARKERS.ls],
    exclude: [
      APPLET_MARKERS.mkdir,
      APPLET_MARKERS.find,
      APPLET_MARKERS.mktemp,
      APPLET_MARKERS.xargs,
      APPLET_MARKERS.seq,
      APPLET_MARKERS.grep,
      APPLET_MARKERS.file,
      PARSER,
      REGISTRY,
      OPAQUE_NAMESPACE,
      INTERACTIVE,
    ],
  },
  {
    name: "commands",
    config: "wrangler.commands-tree-shake.jsonc",
    describe: "a small explicit registry of two applets",
    include: [APPLET_MARKERS.cat, APPLET_MARKERS.grep],
    exclude: [
      APPLET_MARKERS.mkdir,
      APPLET_MARKERS.mktemp,
      APPLET_MARKERS.diff,
      APPLET_MARKERS.patch,
      APPLET_MARKERS.join,
      APPLET_MARKERS.xargs,
      APPLET_MARKERS.seq,
      OPAQUE_NAMESPACE,
      INTERACTIVE,
    ],
  },
  {
    name: "vfs",
    config: "wrangler.vfs-tree-shake.jsonc",
    describe: "the VFS contract with no shell code",
    include: [],
    exclude: [PARSER, REGISTRY, APPLET_MARKERS.mkdir, OPAQUE_NAMESPACE, INTERACTIVE],
  },
  {
    name: "shell",
    config: "wrangler.shell-tree-shake.jsonc",
    describe: "the non-interactive shell with one applet",
    include: [PARSER, REGISTRY],
    exclude: [INTERACTIVE, APPLET_MARKERS.mkdir, APPLET_MARKERS.grep, OPAQUE_NAMESPACE],
  },
  {
    name: "interactive",
    config: "wrangler.interactive-tree-shake.jsonc",
    describe: "the interactive session adapter",
    include: [PARSER, REGISTRY, INTERACTIVE],
    exclude: [APPLET_MARKERS.mkdir, APPLET_MARKERS.grep, OPAQUE_NAMESPACE],
  },
  {
    name: "default-registry",
    config: "wrangler.default-registry-tree-shake.jsonc",
    describe: "the convenience preset with every applet",
    include: [
      PARSER,
      REGISTRY,
      APPLET_MARKERS.mkdir,
      APPLET_MARKERS.find,
      APPLET_MARKERS.mktemp,
      APPLET_MARKERS.xargs,
      APPLET_MARKERS.seq,
      APPLET_MARKERS.grep,
      APPLET_MARKERS.join,
      APPLET_MARKERS.file,
    ],
    exclude: [INTERACTIVE, R2_ADAPTER],
  },
  {
    name: "r2-opaque",
    config: "wrangler.r2-opaque-tree-shake.jsonc",
    describe: "the SQL filesystem with the R2 opaque adapter",
    include: [R2_ADAPTER],
    exclude: [PARSER, REGISTRY, APPLET_MARKERS.mkdir, INTERACTIVE],
  },
];

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
    return await readFile(join(outputDirectory, workerFile), "utf8");
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

const measured = [];
const failures = [];
for (const preset of PRESETS) {
  const source = await bundle(preset.config);
  for (const marker of preset.include) {
    assert(source.includes(marker), `${preset.name} bundle is missing ${JSON.stringify(marker)}`);
  }
  for (const marker of preset.exclude) {
    assert(!source.includes(marker), `${preset.name} bundle contains ${JSON.stringify(marker)}`);
  }
  assert(
    !source.includes(NODE_SQLITE),
    `${preset.name} Worker bundle contains the Node SQLite adapter`,
  );

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
  await writeFile(budgetUrl, `${JSON.stringify(budgetFile, null, 2)}\n`);
  console.log(`recorded ${PRESETS.length} bundle budgets`);
} else {
  assert.deepEqual(failures, [], `bundle budgets:\n  ${failures.join("\n  ")}`);
  console.log(`tree-shaking and bundle budgets verified across ${PRESETS.length} presets`);
}

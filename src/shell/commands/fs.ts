import { VfsError } from "../../core/errors.js";
import { basename, dirname, normalizePath } from "../../core/path.js";
import type { VfsStat } from "../../vfs/types.js";
import {
  type AppletSpec,
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import { modeString } from "./format.js";
import { BufferedTextWriter, commandPath, pipeToSink, writeText } from "./helpers.js";

const CAT = {
  name: "cat",
  usage: "[FILE...]",
  summary: "concatenates files, or standard input, to standard output",
} as const satisfies AppletSpec;

const MKDIR = {
  name: "mkdir",
  usage: "[-p] [-m MODE] DIRECTORY...",
  summary: "creates directories",
  options: {
    short: {
      p: { name: "parents" },
      m: { name: "mode", argument: true },
    },
    long: {
      parents: { name: "parents" },
      mode: { name: "mode", argument: true },
    },
  },
} as const satisfies AppletSpecWithOptions<"parents" | "mode">;

const TOUCH = {
  name: "touch",
  usage: "[-c] FILE...",
  summary: "updates modification times and creates missing files",
  options: {
    short: { c: { name: "no-create" } },
    long: { "no-create": { name: "no-create" } },
  },
} as const satisfies AppletSpecWithOptions<"no-create">;

const RM = {
  name: "rm",
  usage: "[-rRf] PATH...",
  summary: "removes files and, with -r, directory subtrees",
  options: {
    short: {
      r: { name: "recursive" },
      R: { name: "recursive" },
      f: { name: "force" },
    },
    long: {
      recursive: { name: "recursive" },
      force: { name: "force" },
    },
  },
} as const satisfies AppletSpecWithOptions<"recursive" | "force">;

const RMDIR = {
  name: "rmdir",
  usage: "DIRECTORY...",
  summary: "removes empty directories",
} as const satisfies AppletSpec;

const MV = {
  name: "mv",
  usage: "[-f] SOURCE DESTINATION",
  summary: "renames a path, replacing the destination only with -f",
  options: {
    short: { f: { name: "force" } },
    long: { force: { name: "force" } },
  },
} as const satisfies AppletSpecWithOptions<"force">;

const CP = {
  name: "cp",
  usage: "[-rRf] SOURCE DESTINATION",
  summary: "copies a file or, with -r, a directory subtree",
  options: {
    short: {
      f: { name: "force" },
      r: { name: "recursive" },
      R: { name: "recursive" },
    },
    long: {
      force: { name: "force" },
      recursive: { name: "recursive" },
    },
  },
} as const satisfies AppletSpecWithOptions<"force" | "recursive">;

const FIND = {
  name: "find",
  usage: "[PATH...] [-name PATTERN] [-type f|d] [-maxdepth N] [-print]",
  summary: "walks a subtree and prints matching paths",
} as const satisfies AppletSpec;

const STAT = {
  name: "stat",
  usage: "PATH...",
  summary: "prints size, kind, mode, revision, and mutation token",
} as const satisfies AppletSpec;

const CHMOD = {
  name: "chmod",
  usage: "OCTAL-MODE PATH...",
  summary: "sets the compatibility mode bits of a path",
} as const satisfies AppletSpec;

const DU = {
  name: "du",
  usage: "[PATH...]",
  summary: "reports subtree size in kibibytes",
} as const satisfies AppletSpec;

const TREE = {
  name: "tree",
  usage: "[PATH]",
  summary: "prints an indented subtree listing",
} as const satisfies AppletSpec;

const BASENAME = {
  name: "basename",
  usage: "PATH",
  summary: "prints the final component of a path",
} as const satisfies AppletSpec;

const DIRNAME = {
  name: "dirname",
  usage: "PATH",
  summary: "prints the directory component of a path",
} as const satisfies AppletSpec;

const REALPATH = {
  name: "realpath",
  usage: "PATH...",
  summary: "prints the normalized absolute path of an existing entry",
} as const satisfies AppletSpec;

const MKTEMP = {
  name: "mktemp",
  usage: "[TEMPLATE]",
  summary: "creates a uniquely named empty file",
} as const satisfies AppletSpec;

const FILE = {
  name: "file",
  usage: "PATH...",
  summary: "classifies a path as directory, inline data, or opaque content",
} as const satisfies AppletSpec;

export const catCommand = /* @__PURE__ */ defineApplet(CAT, async (context, argv, fds) => {
  if (argv.length === 0) {
    await pipeToSink(context, fds[0], fds[1]);
    return 0;
  }
  for (const path of argv) {
    if (path === "-") await pipeToSink(context, fds[0], fds[1]);
    else
      await pipeToSink(
        context,
        context.fileSystem.readFile(commandPath(context, path)).stream,
        fds[1],
      );
  }
  return 0;
});

export const mkdirCommand = /* @__PURE__ */ defineApplet(MKDIR, async (context, argv) => {
  const parsed = parseAppletOptions(MKDIR, argv);
  const recursive = parsed.options.some((option) => option.name === "parents");
  let mode: number | undefined;
  for (const option of parsed.options) {
    if (option.name === "mode" && "argument" in option) {
      if (!/^[0-7]{3,4}$/u.test(option.argument)) {
        throw appletUsageError(MKDIR, "mode must be octal");
      }
      mode = 0o040000 | Number.parseInt(option.argument, 8);
    }
  }
  if (parsed.operands.length === 0) throw appletUsageError(MKDIR, "missing operand");
  for (const path of parsed.operands) {
    context.fileSystem.mkdir(commandPath(context, path), recursive, mode);
  }
  return 0;
});

export const touchCommand = /* @__PURE__ */ defineApplet(TOUCH, async (context, argv) => {
  const parsed = parseAppletOptions(TOUCH, argv);
  const create = !parsed.options.some((option) => option.name === "no-create");
  if (parsed.operands.length === 0) throw appletUsageError(TOUCH, "missing operand");
  for (const path of parsed.operands) {
    try {
      context.fileSystem.touch(commandPath(context, path), { create });
    } catch (error) {
      if (!(!create && error instanceof VfsError && error.code === "ENOENT")) throw error;
    }
  }
  return 0;
});

export const rmCommand = /* @__PURE__ */ defineApplet(RM, async (context, argv) => {
  const parsed = parseAppletOptions(RM, argv);
  const recursive = parsed.options.some((option) => option.name === "recursive");
  const force = parsed.options.some((option) => option.name === "force");
  if (parsed.operands.length === 0 && !force) throw appletUsageError(RM, "missing operand");
  for (const path of parsed.operands) {
    try {
      await context.fileSystem.remove(commandPath(context, path), { recursive });
    } catch (error) {
      if (!(force && error instanceof VfsError && error.code === "ENOENT")) throw error;
    }
  }
  return 0;
});

export const rmdirCommand = /* @__PURE__ */ defineApplet(RMDIR, async (context, argv) => {
  if (argv.length === 0) throw appletUsageError(RMDIR, "missing operand");
  for (const path of argv) {
    const normalized = commandPath(context, path);
    const stat = context.fileSystem.stat(normalized);
    if (stat.kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", normalized);
    await context.fileSystem.remove(normalized);
  }
  return 0;
});

function destinationPath(
  context: Parameters<typeof commandPath>[0],
  source: string,
  targetValue: string,
): string {
  const target = commandPath(context, targetValue);
  const stat = context.fileSystem.inspectWriteTarget(target);
  if (stat === null) return target;
  return stat.kind === "directory" ? `${target === "/" ? "" : target}/${basename(source)}` : target;
}

export const mvCommand = /* @__PURE__ */ defineApplet(MV, async (context, argv) => {
  const parsed = parseAppletOptions(MV, argv);
  const replace = parsed.options.some((option) => option.name === "force");
  const values = parsed.operands;
  if (values.length !== 2) throw appletUsageError(MV, "requires source and destination");
  const source = commandPath(context, values[0]);
  const target = destinationPath(context, source, values[1] ?? "");
  await context.fileSystem.move(source, target, { replace });
  return 0;
});

export const cpCommand = /* @__PURE__ */ defineApplet(CP, async (context, argv) => {
  const parsed = parseAppletOptions(CP, argv);
  const replace = parsed.options.some((option) => option.name === "force");
  const recursive = parsed.options.some((option) => option.name === "recursive");
  const values = parsed.operands;
  if (values.length !== 2) throw appletUsageError(CP, "requires source and destination");
  const source = commandPath(context, values[0]);
  const target = destinationPath(context, source, values[1] ?? "");
  await context.fileSystem.copy(source, target, { replace, recursive });
  return 0;
});

export const findCommand = /* @__PURE__ */ defineApplet(FIND, async (context, argv, fds) => {
  const roots: string[] = [];
  let name: string | undefined;
  let type: "file" | "directory" | undefined;
  let maxDepth: number | undefined;
  let index = 0;
  while (index < argv.length && !(argv[index] ?? "").startsWith("-"))
    roots.push(argv[index++] ?? ".");
  if (roots.length === 0) roots.push(".");
  while (index < argv.length) {
    const option = argv[index++];
    if (option === "-name") {
      name = argv[index++];
      if (name === undefined) throw appletUsageError(FIND, "-name requires a pattern");
    } else if (option === "-type") {
      const value = argv[index++];
      if (value === "f") type = "file";
      else if (value === "d") type = "directory";
      else throw appletUsageError(FIND, "-type must be f or d");
    } else if (option === "-maxdepth") {
      const value = argv[index++];
      if (value === undefined || !/^[0-9]+$/u.test(value)) {
        throw appletUsageError(FIND, "-maxdepth requires a non-negative integer");
      }
      maxDepth = Number(value);
    } else if (option === "-print") continue;
    else throw appletUsageError(FIND, `unsupported expression ${option ?? ""}`);
  }
  const output = new BufferedTextWriter(context, fds[1]);
  try {
    for (const root of roots) {
      const normalized = commandPath(context, root);
      const entries = context.fileSystem.find({
        path: normalized,
        includeRoot: true,
        ...(name === undefined ? {} : { name }),
        ...(type === undefined ? {} : { type }),
        ...(maxDepth === undefined ? {} : { maxDepth }),
        limit: context.budget.limits.maxGlobMatches,
      });
      for (const entry of entries) await output.write(`${entry.path}\n`);
    }
    await output.flush();
  } finally {
    output.abort();
  }
  return 0;
});

function statText(stat: VfsStat): string {
  return `${[
    `  File: ${stat.path}`,
    `  Size: ${stat.sizeBytes}`,
    `  Type: ${stat.kind === "directory" ? "directory" : `${stat.contentClass} file`}`,
    `  Mode: ${stat.mode.toString(8)} (${modeString(stat.mode)})`,
    `Revision: ${stat.revision}`,
    `Mutation: ${stat.mutationToken}`,
  ].join("\n")}\n`;
}

export const statCommand = /* @__PURE__ */ defineApplet(STAT, async (context, argv, fds) => {
  if (argv.length === 0) throw appletUsageError(STAT, "missing operand");
  for (const path of argv) {
    await writeText(fds[1], statText(context.fileSystem.stat(commandPath(context, path))));
  }
  return 0;
});

export const chmodCommand = /* @__PURE__ */ defineApplet(CHMOD, async (context, argv) => {
  const [modeValue, ...paths] = argv;
  if (modeValue === undefined || paths.length === 0 || !/^[0-7]{3,4}$/u.test(modeValue)) {
    throw appletUsageError(CHMOD, "requires an octal mode and paths");
  }
  const permission = Number.parseInt(modeValue, 8);
  for (const path of paths) {
    const normalized = commandPath(context, path);
    const stat = context.fileSystem.stat(normalized);
    context.fileSystem.setMetadata(normalized, {
      mode: (stat.kind === "directory" ? 0o040000 : 0o100000) | permission,
    });
  }
  return 0;
});

export const duCommand = /* @__PURE__ */ defineApplet(DU, async (context, argv, fds) => {
  const paths = argv.length === 0 ? ["."] : [...argv];
  for (const path of paths) {
    const normalized = commandPath(context, path);
    const entries = context.fileSystem.find({ path: normalized, includeRoot: true });
    const size = entries.reduce(
      (total, stat) => total + (stat.kind === "file" ? stat.sizeBytes : 0),
      0,
    );
    await writeText(fds[1], `${Math.ceil(size / 1024)}\t${path}\n`);
  }
  return 0;
});

export const treeCommand = /* @__PURE__ */ defineApplet(TREE, async (context, argv, fds) => {
  const rootValue = argv[0] ?? ".";
  const root = commandPath(context, rootValue);
  const entries = context.fileSystem.find({ path: root, includeRoot: true });
  const output = new BufferedTextWriter(context, fds[1]);
  try {
    for (const entry of entries) {
      const relative =
        entry.path === root ? "." : entry.path.slice(root === "/" ? 1 : root.length + 1);
      const depth = relative === "." ? 0 : relative.split("/").length;
      await output.write(`${"  ".repeat(Math.max(0, depth - 1))}${entry.name}\n`);
    }
    await output.flush();
  } finally {
    output.abort();
  }
  return 0;
});

export const basenameCommand = /* @__PURE__ */ defineApplet(
  BASENAME,
  async (_context, argv, fds) => {
    if (argv.length !== 1) throw appletUsageError(BASENAME, "requires one path");
    await writeText(fds[1], `${basename(argv[0] ?? "")}\n`);
    return 0;
  },
);

export const dirnameCommand = /* @__PURE__ */ defineApplet(DIRNAME, async (_context, argv, fds) => {
  if (argv.length !== 1) throw appletUsageError(DIRNAME, "requires one path");
  await writeText(fds[1], `${dirname(argv[0] ?? "")}\n`);
  return 0;
});

export const realpathCommand = /* @__PURE__ */ defineApplet(
  REALPATH,
  async (context, argv, fds) => {
    if (argv.length === 0) throw appletUsageError(REALPATH, "missing operand");
    for (const path of argv) {
      const normalized = normalizePath(path, context.session.cwd);
      context.fileSystem.stat(normalized);
      await writeText(fds[1], `${normalized}\n`);
    }
    return 0;
  },
);

export const mktempCommand = /* @__PURE__ */ defineApplet(MKTEMP, async (context, argv, fds) => {
  if (argv.length > 1) throw appletUsageError(MKTEMP, "accepts at most one template");
  const template = argv[0] ?? "tmp.XXXXXX";
  if (template.startsWith("-")) throw appletUsageError(MKTEMP, `unsupported option ${template}`);
  if (!template.includes("XXXXXX")) throw appletUsageError(MKTEMP, "template must contain XXXXXX");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 6);
    const path = commandPath(context, template.replace("XXXXXX", suffix));
    try {
      await context.fileSystem.writeFile(path, new Uint8Array(), { disposition: "create" });
      await writeText(fds[1], `${path}\n`);
      return 0;
    } catch (error) {
      if (!(error instanceof VfsError && error.code === "EEXIST")) throw error;
    }
  }
  throw new VfsError("EEXIST", "mktemp: could not create a unique file");
});

export const fileCommand = /* @__PURE__ */ defineApplet(FILE, async (context, argv, fds) => {
  if (argv.length === 0) throw appletUsageError(FILE, "missing operand");
  for (const path of argv) {
    const stat = context.fileSystem.stat(commandPath(context, path));
    const description =
      stat.kind === "directory"
        ? "directory"
        : stat.contentClass === "opaque"
          ? "opaque R2 content"
          : "inline data";
    await writeText(fds[1], `${path}: ${description}\n`);
  }
  return 0;
});

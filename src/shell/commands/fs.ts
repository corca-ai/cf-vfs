import { VfsError } from "../../core/errors.js";
import { matchesGlob } from "../../core/glob.js";
import { basename, dirname, normalizePath } from "../../core/path.js";
import type { EntryKind, VfsStat } from "../../vfs/types.js";
import { openContent } from "../content.js";
import {
  type AppletSpec,
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import { CHARACTER_DEVICE_TYPE, FILE_TYPE_MASK, isRegularFile, modeString } from "./format.js";
import {
  BufferedTextWriter,
  commandPath,
  destinationPath,
  displayPath,
  pipeToSink,
  writeText,
} from "./helpers.js";

/** Paths one `-exec ... +` invocation may carry. */
const FIND_EXEC_BATCH = 256;

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
  usage: "[-rRfpP] SOURCE DESTINATION",
  summary: "copies a file or, with -r, a directory subtree",
  options: {
    short: {
      f: { name: "force" },
      r: { name: "recursive" },
      R: { name: "recursive" },
      p: { name: "preserve" },
      P: { name: "no-dereference" },
    },
    long: {
      force: { name: "force" },
      recursive: { name: "recursive" },
      preserve: { name: "preserve" },
      "no-dereference": { name: "no-dereference" },
    },
  },
} as const satisfies AppletSpecWithOptions<"force" | "recursive" | "preserve" | "no-dereference">;

const FIND = {
  name: "find",
  usage: "[PATH...] [-name PATTERN] [-type f|d|l] [-maxdepth N] [-print|-print0|-exec ... ;|+]",
  summary: "walks a subtree and prints or runs a command on matching paths",
} as const satisfies AppletSpec;

const STAT = {
  name: "stat",
  usage: "[-L] [-c FORMAT] PATH...",
  summary: "prints size, kind, mode, revision, and mutation token",
  options: {
    short: { c: { name: "format", argument: true }, L: { name: "dereference" } },
    long: { format: { name: "format", argument: true }, dereference: { name: "dereference" } },
  },
} as const satisfies AppletSpecWithOptions<"format" | "dereference">;

const CHMOD = {
  name: "chmod",
  usage: "OCTAL-MODE|SYMBOLIC-MODE PATH...",
  summary: "sets the compatibility mode bits of a path",
} as const satisfies AppletSpec;

const SYMBOLIC_MODE = /^([ugoa]*)([-+=])([rwx]*)$/u;

/**
 * Applies one symbolic mode clause to existing permission bits.
 *
 * The profile covers the spellings scripts actually use — `+x`, `u+x`,
 * `go-w`, `a=rx` — and nothing else. `s`, `t`, `X`, numeric copies such as
 * `u=g`, and an omitted `umask` interaction are outside it, so an unsupported
 * clause is a usage error rather than an approximation.
 */
function applySymbolicMode(permission: number, clause: string, spec: AppletSpec): number {
  const match = SYMBOLIC_MODE.exec(clause);
  if (match === null) throw appletUsageError(spec, `unsupported mode: ${clause}`);
  const [, whoValue = "", operator = "", permissions = ""] = match;
  // A bare operator means every class, exactly as `chmod +x` does.
  const who = whoValue === "" || whoValue.includes("a") ? "ugo" : whoValue;
  let bits = 0;
  for (const shift of [
    ["u", 6],
    ["g", 3],
    ["o", 0],
  ] as const) {
    if (!who.includes(shift[0])) continue;
    if (permissions.includes("r")) bits |= 0o4 << shift[1];
    if (permissions.includes("w")) bits |= 0o2 << shift[1];
    if (permissions.includes("x")) bits |= 0o1 << shift[1];
  }
  if (operator === "+") return permission | bits;
  if (operator === "-") return permission & ~bits;
  // `=` replaces only the classes the clause names.
  let cleared = permission;
  for (const shift of [
    ["u", 6],
    ["g", 3],
    ["o", 0],
  ] as const) {
    if (who.includes(shift[0])) cleared &= ~(0o7 << shift[1]);
  }
  return cleared | bits;
}

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
    if (path === "-") {
      await pipeToSink(context, fds[0], fds[1]);
      continue;
    }
    const body = await openContent(context.fileSystem, commandPath(context, path), {
      reader: context.content,
      access: context.policy.opaqueContent,
      signal: context.signal,
    });
    await pipeToSink(context, body.stream, fds[1]);
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
  const preserve = parsed.options.some((option) => option.name === "preserve");
  const noDereference = parsed.options.some((option) => option.name === "no-dereference");
  const values = parsed.operands;
  if (values.length !== 2) throw appletUsageError(CP, "requires source and destination");
  const source = commandPath(context, values[0]);
  const target = destinationPath(context, source, values[1] ?? "");
  // A named link is copied through, as GNU does; `-r` and `-P` copy the link
  // itself, because a subtree full of dereferenced links is a different tree.
  const dereference = !recursive && !noDereference;
  // The metadata of what was copied, which is the target when the copy
  // followed the link and the link itself when it did not.
  const preserved = preserve
    ? dereference
      ? context.fileSystem.stat(source)
      : context.fileSystem.lstat(source)
    : undefined;
  await context.fileSystem.copy(source, target, { replace, recursive, dereference });
  // Mode bits and the modification time are what this namespace has to
  // preserve; there is no owner, group, or access time behind them. A copy
  // carries each entry's own bits already but stamps every entry with the
  // current time, so the named target is restated here. Descendants of a
  // recursive copy keep the copy's time, which is a declared divergence.
  // A copied link is skipped: its mode is fixed, and `setMetadata` follows, so
  // restating it would stamp whatever it points at instead.
  if (preserved !== undefined && preserved.kind !== "symlink") {
    context.fileSystem.setMetadata(target, {
      mode: preserved.mode,
      modifiedAtMs: preserved.modifiedAtMs,
    });
  }
  return 0;
});

/**
 * Walks a subtree and prints or runs a command on matching paths.
 *
 * `-print0` separates with NUL so a path containing a newline survives the
 * hand-off to `xargs -0`. `-exec` dispatches an already-expanded argv through
 * the same registry, policy, and budget as any other command, so a matched path
 * can never become shell syntax; `;` runs once per path and `+` batches, both
 * charging the command budget per invocation.
 */
export const findCommand = /* @__PURE__ */ defineApplet(FIND, async (context, argv, fds) => {
  const roots: string[] = [];
  let name: string | undefined;
  let type: EntryKind | undefined;
  let maxDepth: number | undefined;
  let separator: string | undefined;
  let exec: { argv: string[]; batch: boolean } | undefined;
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
      else if (value === "l") type = "symlink";
      else throw appletUsageError(FIND, "-type must be f, d, or l");
    } else if (option === "-maxdepth") {
      const value = argv[index++];
      if (value === undefined || !/^[0-9]+$/u.test(value)) {
        throw appletUsageError(FIND, "-maxdepth requires a non-negative integer");
      }
      maxDepth = Number(value);
    } else if (option === "-print") separator = "\n";
    else if (option === "-print0") separator = "\0";
    else if (option === "-exec") {
      const command: string[] = [];
      let terminator: string | undefined;
      while (index < argv.length) {
        const word = argv[index++];
        if (word === ";" || word === "+") {
          terminator = word;
          break;
        }
        command.push(word ?? "");
      }
      if (terminator === undefined) throw appletUsageError(FIND, "-exec requires ; or +");
      if (command.length === 0) throw appletUsageError(FIND, "-exec requires a command");
      const batch = terminator === "+";
      if (batch && command.at(-1) !== "{}") {
        throw appletUsageError(FIND, "-exec ... + requires {} as the last argument");
      }
      exec = { argv: command, batch };
    } else throw appletUsageError(FIND, `unsupported expression ${option ?? ""}`);
  }
  if (exec !== undefined && separator !== undefined) {
    throw appletUsageError(FIND, "specify either -exec or a print action");
  }

  const matched: string[] = [];
  for (const root of roots) {
    const normalized = commandPath(context, root);
    // A link named on the command line is not descended into, as POSIX has it:
    // `find dirlink` reports the link and stops. Following it would let one
    // operand walk a tree that is not below where the caller pointed.
    const operand = context.fileSystem.lstat(normalized);
    if (operand.kind === "symlink") {
      const selected =
        (type === undefined || type === "symlink") &&
        (name === undefined || matchesGlob(operand.name, name));
      // Named the way the operand was written, like every other match.
      if (selected) matched.push(displayPath(root, normalized, normalized));
      continue;
    }
    const entries = context.fileSystem.find({
      path: normalized,
      includeRoot: true,
      ...(name === undefined ? {} : { name }),
      ...(type === undefined ? {} : { type }),
      ...(maxDepth === undefined ? {} : { maxDepth }),
      limit: context.budget.limits.maxGlobMatches,
    });
    // Report each match the way the operand was written, as `find` does.
    for (const entry of entries) matched.push(displayPath(root, normalized, entry.path));
  }

  if (exec === undefined) {
    const end = separator ?? "\n";
    const output = new BufferedTextWriter(context, fds[1]);
    try {
      for (const path of matched) await output.write(`${path}${end}`);
      await output.flush();
    } finally {
      output.abort();
    }
    return 0;
  }

  // A failing invocation does not stop the walk; the status reports that one
  // of them failed, which is what `find` promises.
  let failed = false;
  const run = async (paths: readonly string[]): Promise<void> => {
    const expanded = exec.batch
      ? [...exec.argv.slice(0, -1), ...paths]
      : // Every occurrence, not only a word that is exactly `{}`: the idiom
        // `-exec mv {} {}.bak ;` otherwise renames onto a literal `{}.bak`.
        exec.argv.map((word) => word.split("{}").join(paths[0] ?? ""));
    const status = await context.executeCommand(expanded, fds);
    // Only the `+` form propagates a failing invocation. With `;` the status of
    // each command is `find`'s business and not its result, as POSIX has it.
    if (status !== 0 && exec.batch) failed = true;
  };
  if (exec.batch) {
    // Batches are bounded so one invocation cannot carry an unbounded argv.
    for (let start = 0; start < matched.length; start += FIND_EXEC_BATCH) {
      await run(matched.slice(start, start + FIND_EXEC_BATCH));
    }
  } else {
    for (const path of matched) await run([path]);
  }
  return failed ? 1 : 0;
});

function statText(stat: VfsStat): string {
  return `${[
    `  File: ${stat.path}`,
    `  Size: ${stat.sizeBytes}`,
    `  Type: ${
      stat.kind === "symlink"
        ? `symbolic link -> ${stat.linkTarget}`
        : stat.kind === "file" && isRegularFile(stat)
          ? `${stat.contentClass} file`
          : describeKind(stat)
    }`,
    `  Mode: ${stat.mode.toString(8)} (${modeString(stat.mode)})`,
    `Revision: ${stat.revision}`,
    `Mutation: ${stat.mutationToken}`,
  ].join("\n")}\n`;
}

/**
 * Prints entry metadata.
 *
 * `-c` selects a machine-stable format so a script can read one field without
 * parsing a human report. The conversions name what this namespace actually
 * has: there is no owner, group, inode, or link count to report, so those
 * spellings are refused rather than filled with a placeholder.
 */
export const statCommand = /* @__PURE__ */ defineApplet(STAT, async (context, argv, fds) => {
  const parsed = parseAppletOptions(STAT, argv);
  const format = parsed.options.find(
    (option): option is { name: "format"; argument: string } =>
      option.name === "format" && "argument" in option,
  )?.argument;
  if (parsed.operands.length === 0) throw appletUsageError(STAT, "missing operand");
  // GNU reports the link itself unless `-L` is given, so `stat link` says
  // "symbolic link" and does not quietly describe something else.
  const dereference = parsed.options.some((option) => option.name === "dereference");
  for (const path of parsed.operands) {
    const resolved = commandPath(context, path);
    const stat = dereference
      ? context.fileSystem.stat(resolved)
      : context.fileSystem.lstat(resolved);
    await writeText(
      fds[1],
      format === undefined ? statText(stat) : `${statFormat(format, stat, path)}\n`,
    );
  }
  return 0;
});

/** What `stat -c %F` and `file` call an entry, from the mode's type field. */
function describeKind(stat: VfsStat): string {
  if (stat.kind === "directory") return "directory";
  if (stat.kind === "symlink") return "symbolic link";
  return (stat.mode & FILE_TYPE_MASK) === CHARACTER_DEVICE_TYPE
    ? "character special file"
    : "regular file";
}

/** Expands the `-c` conversions this namespace can answer. */
function statFormat(format: string, stat: VfsStat, operand: string): string {
  let output = "";
  for (let index = 0; index < format.length; index += 1) {
    const character = format[index] ?? "";
    if (character === "\\") {
      const next = format[++index];
      output += next === "n" ? "\n" : next === "t" ? "\t" : (next ?? "\\");
      continue;
    }
    if (character !== "%") {
      output += character;
      continue;
    }
    const conversion = format[++index];
    if (conversion === "n") output += operand;
    else if (conversion === "s") output += String(stat.sizeBytes);
    // `%f` is the raw mode in hex, which is what GNU prints; `%a` is the
    // permission bits in octal.
    else if (conversion === "f") output += stat.mode.toString(16);
    else if (conversion === "a") output += (stat.mode & 0o7777).toString(8);
    else if (conversion === "A") output += modeString(stat.mode);
    else if (conversion === "F") output += describeKind(stat);
    else if (conversion === "%") output += "%";
    else throw appletUsageError(STAT, `unsupported conversion %${conversion ?? ""}`);
  }
  return output;
}

export const chmodCommand = /* @__PURE__ */ defineApplet(CHMOD, async (context, argv) => {
  const [modeValue, ...paths] = argv;
  if (modeValue === undefined || paths.length === 0) {
    throw appletUsageError(CHMOD, "requires a mode and paths");
  }
  const octal = /^[0-7]{3,4}$/u.test(modeValue);
  const clauses = octal ? [] : modeValue.split(",");
  for (const path of paths) {
    const normalized = commandPath(context, path);
    const stat = context.fileSystem.stat(normalized);
    // A symbolic mode reads the current bits; an octal mode replaces them.
    let permission = octal ? Number.parseInt(modeValue, 8) : stat.mode & 0o7777;
    for (const clause of clauses) permission = applySymbolicMode(permission, clause, CHMOD);
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
      // Resolve first, then confirm: a link is only canonical once it has been
      // followed, and `stat` on the written path would follow it anyway.
      const canonical = context.fileSystem.realpath(normalized);
      context.fileSystem.stat(canonical);
      await writeText(fds[1], `${canonical}\n`);
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
    // `lstat`, so a link is described as a link rather than as its target.
    const stat = context.fileSystem.lstat(commandPath(context, path));
    const description =
      stat.kind === "symlink"
        ? `symbolic link to ${stat.linkTarget}`
        : stat.kind === "file" && stat.contentClass === "opaque"
          ? "opaque R2 content"
          : stat.kind === "file" && isRegularFile(stat)
            ? "inline data"
            : describeKind(stat);
    await writeText(fds[1], `${path}: ${description}\n`);
  }
  return 0;
});

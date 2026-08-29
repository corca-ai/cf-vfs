import { matchesGlob } from "../../core/glob.js";
import { depthFrom } from "../../core/path.js";
import type { EntryKind, FindOptions, VfsStat } from "../../vfs/types.js";
import type { ShellCommandContext, ShellFileDescriptors } from "../types.js";
import { type AppletSpec, appletUsageError, defineApplet } from "./applet.js";
import { BufferedTextWriter, commandPath, displayPath, writeText } from "./helpers.js";

/** Paths one `-exec ... +` invocation may carry. */
const FIND_EXEC_BATCH = 256;

const FIND = {
  name: "find",
  usage: "[PATH...] [-name PATTERN] [-type f|d|l] [-maxdepth N] [-print|-print0|-exec ... ;|+]",
  summary: "walks a subtree and prints or runs a command on matching paths",
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

function boundedFind(
  context: ShellCommandContext,
  options: Pick<FindOptions, "path" | "includeRoot">,
): VfsStat[] {
  // Ask for one sentinel beyond the budget. `find()` keeps one scan context
  // across its internal pages, so permission preflight is paid only once.
  const maximum = context.budget.limits.maxGlobMatches;
  const entries = context.fileSystem.find({
    ...options,
    limit: maximum === Number.MAX_SAFE_INTEGER ? maximum : maximum + 1,
  });
  context.budget.glob(entries.length);
  return entries;
}

interface FindExec {
  readonly argv: readonly string[];
  readonly batch: boolean;
}

interface FindInvocation {
  readonly roots: readonly string[];
  readonly name?: string;
  readonly type?: EntryKind;
  readonly maxDepth?: number;
  readonly separator?: string;
  readonly exec?: FindExec;
}

class FindArgumentParser {
  private index = 0;
  private readonly roots: string[] = [];
  private name: string | undefined;
  private type: EntryKind | undefined;
  private maxDepth: number | undefined;
  private separator: string | undefined;
  private exec: FindExec | undefined;

  constructor(private readonly argv: readonly string[]) {}

  parse(): FindInvocation {
    this.parseRoots();
    while (this.index < this.argv.length) this.parseExpression();
    if (this.exec !== undefined && this.separator !== undefined) {
      throw appletUsageError(FIND, "specify either -exec or a print action");
    }
    return {
      roots: this.roots,
      ...(this.name === undefined ? {} : { name: this.name }),
      ...(this.type === undefined ? {} : { type: this.type }),
      ...(this.maxDepth === undefined ? {} : { maxDepth: this.maxDepth }),
      ...(this.separator === undefined ? {} : { separator: this.separator }),
      ...(this.exec === undefined ? {} : { exec: this.exec }),
    };
  }

  private parseRoots(): void {
    while (this.index < this.argv.length && !(this.argv[this.index] ?? "").startsWith("-")) {
      this.roots.push(this.argv[this.index++] ?? ".");
    }
    if (this.roots.length === 0) this.roots.push(".");
  }

  private parseExpression(): void {
    const option = this.argv[this.index++];
    if (option === "-name") this.name = this.requiredValue("-name requires a pattern");
    else if (option === "-type") this.type = this.parseType();
    else if (option === "-maxdepth") this.maxDepth = this.parseMaxDepth();
    else if (option === "-print") this.separator = "\n";
    else if (option === "-print0") this.separator = "\0";
    else if (option === "-exec") this.exec = this.parseExec();
    else throw appletUsageError(FIND, `unsupported expression ${option ?? ""}`);
  }

  private requiredValue(message: string): string {
    const value = this.argv[this.index++];
    if (value === undefined) throw appletUsageError(FIND, message);
    return value;
  }

  private parseType(): EntryKind {
    const value = this.requiredValue("-type must be f, d, or l");
    if (value === "f") return "file";
    if (value === "d") return "directory";
    if (value === "l") return "symlink";
    throw appletUsageError(FIND, "-type must be f, d, or l");
  }

  private parseMaxDepth(): number {
    const value = this.requiredValue("-maxdepth requires a non-negative integer");
    if (!/^[0-9]+$/u.test(value)) {
      throw appletUsageError(FIND, "-maxdepth requires a non-negative integer");
    }
    return Number(value);
  }

  private parseExec(): FindExec {
    const command: string[] = [];
    let terminator: string | undefined;
    while (this.index < this.argv.length) {
      const word = this.argv[this.index++];
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
    return { argv: command, batch };
  }
}

function selectedFindEntry(
  entry: VfsStat,
  invocation: FindInvocation,
  traversalRoot: string,
): boolean {
  if (invocation.type !== undefined && entry.kind !== invocation.type) return false;
  if (invocation.name !== undefined && !matchesGlob(entry.name, invocation.name)) return false;
  return (
    invocation.maxDepth === undefined || depthFrom(traversalRoot, entry.path) <= invocation.maxDepth
  );
}

function collectFindRoot(
  context: ShellCommandContext,
  root: string,
  invocation: FindInvocation,
): string[] {
  const normalized = commandPath(context, root);
  // A link named on the command line is reported but never descended into.
  const operand = context.fileSystem.lstat(normalized);
  if (operand.kind === "symlink") {
    context.budget.glob(1);
    const selected =
      (invocation.type === undefined || invocation.type === "symlink") &&
      (invocation.name === undefined || matchesGlob(operand.name, invocation.name));
    return selected ? [displayPath(root, normalized, normalized)] : [];
  }
  const traversalRoot = context.fileSystem.realpath(normalized);
  const entries = boundedFind(context, { path: normalized, includeRoot: true });
  return entries
    .filter((entry) => selectedFindEntry(entry, invocation, traversalRoot))
    .map((entry) => displayPath(root, traversalRoot, entry.path));
}

function collectFindMatches(context: ShellCommandContext, invocation: FindInvocation): string[] {
  return invocation.roots.flatMap((root) => collectFindRoot(context, root, invocation));
}

async function printFindMatches(
  context: ShellCommandContext,
  paths: readonly string[],
  separator: string,
  fds: ShellFileDescriptors,
): Promise<number> {
  const output = new BufferedTextWriter(context, fds[1]);
  try {
    for (const path of paths) await output.write(`${path}${separator}`);
    await output.flush();
  } finally {
    output.abort();
  }
  return 0;
}

function findExecArgv(exec: FindExec, paths: readonly string[]): readonly string[] {
  if (exec.batch) return [...exec.argv.slice(0, -1), ...paths];
  return exec.argv.map((word) => word.split("{}").join(paths[0] ?? ""));
}

async function runFindExec(
  context: ShellCommandContext,
  paths: readonly string[],
  exec: FindExec,
  fds: ShellFileDescriptors,
): Promise<number> {
  let failed = false;
  const run = async (batch: readonly string[]): Promise<void> => {
    const status = await context.executeCommand(findExecArgv(exec, batch), fds);
    if (status !== 0 && exec.batch) failed = true;
  };
  if (exec.batch) {
    for (let start = 0; start < paths.length; start += FIND_EXEC_BATCH) {
      await run(paths.slice(start, start + FIND_EXEC_BATCH));
    }
  } else {
    for (const path of paths) await run([path]);
  }
  return failed ? 1 : 0;
}

/** Walks subtrees and prints matches or invokes a command over them. */
export const findCommand = /* @__PURE__ */ defineApplet(FIND, async (context, argv, fds) => {
  const invocation = new FindArgumentParser(argv).parse();
  const matched = collectFindMatches(context, invocation);
  if (invocation.exec !== undefined) return runFindExec(context, matched, invocation.exec, fds);
  return printFindMatches(context, matched, invocation.separator ?? "\n", fds);
});

export const duCommand = /* @__PURE__ */ defineApplet(DU, async (context, argv, fds) => {
  const paths = argv.length === 0 ? ["."] : [...argv];
  for (const path of paths) {
    const normalized = commandPath(context, path);
    const size = context.fileSystem.subtreeSummary(normalized).logicalFileBytes;
    await writeText(fds[1], `${Math.ceil(size / 1024)}\t${path}\n`);
  }
  return 0;
});

export const treeCommand = /* @__PURE__ */ defineApplet(TREE, async (context, argv, fds) => {
  const rootValue = argv[0] ?? ".";
  const root = commandPath(context, rootValue);
  const entries = boundedFind(context, { path: root, includeRoot: true });
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

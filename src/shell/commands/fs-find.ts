import { depthFrom, dirname } from "../../core/path.js";
import type { FindOptions, VfsStat } from "../../vfs/types.js";
import type { ShellCommandContext, ShellFileDescriptors } from "../types.js";
import { type AppletSpec, defineApplet } from "./applet.js";
import {
  type FindEntry,
  type FindExec,
  type FindExpression,
  FindExpressionParser,
  type FindNode,
} from "./fs-find-expression.js";
import { BufferedTextWriter, commandPath, displayPath, writeText } from "./helpers.js";

/** Paths one `-exec ... +` invocation may carry. */
const FIND_EXEC_BATCH = 256;

const FIND = {
  name: "find",
  usage: "[PATH...] [EXPRESSION]",
  summary: "walks subtrees and evaluates tests, operators and actions for each entry",
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

class FindEvaluator {
  private readonly output: BufferedTextWriter;
  private readonly batches = new Map<FindExec, string[]>();
  private readonly pruned = new Set<string>();
  private failed = false;

  constructor(
    private readonly context: ShellCommandContext,
    private readonly fds: ShellFileDescriptors,
  ) {
    this.output = new BufferedTextWriter(context, fds[1]);
  }

  /** Whether a `-prune`d directory contains `path`; entries arrive after their ancestors. */
  isPruned(path: string): boolean {
    if (this.pruned.size === 0) return false;
    for (let ancestor = dirname(path); ; ancestor = dirname(ancestor)) {
      if (this.pruned.has(ancestor)) return true;
      if (ancestor === "/") return false;
    }
  }

  async evaluate(node: FindNode, entry: FindEntry): Promise<boolean> {
    switch (node.kind) {
      case "and":
        return (await this.evaluate(node.left, entry)) && this.evaluate(node.right, entry);
      case "or":
        return (await this.evaluate(node.left, entry)) || this.evaluate(node.right, entry);
      case "not":
        return !(await this.evaluate(node.operand, entry));
      case "test":
        return node.test(entry, this.context);
      case "prune":
        if (entry.stat.kind === "directory") this.pruned.add(entry.stat.path);
        return true;
      case "print":
        await this.output.write(`${entry.display}${node.separator}`);
        return true;
      case "exec":
        return this.exec(node.exec, entry.display);
    }
  }

  async finish(): Promise<number> {
    for (const exec of this.batches.keys()) await this.flushBatch(exec);
    await this.output.flush();
    return this.failed ? 1 : 0;
  }

  abort(): void {
    this.output.abort();
  }

  private async exec(exec: FindExec, path: string): Promise<boolean> {
    if (exec.batch) {
      const pending = this.batches.get(exec) ?? [];
      pending.push(path);
      this.batches.set(exec, pending);
      if (pending.length >= FIND_EXEC_BATCH) await this.flushBatch(exec);
      return true;
    }
    // Output printed so far reaches the descriptor before the command's own.
    await this.output.flush();
    return (await this.context.executeCommand(findExecArgv(exec, [path]), this.fds)) === 0;
  }

  private async flushBatch(exec: FindExec): Promise<void> {
    const paths = this.batches.get(exec) ?? [];
    if (paths.length === 0) return;
    this.batches.set(exec, []);
    await this.output.flush();
    if ((await this.context.executeCommand(findExecArgv(exec, paths), this.fds)) !== 0) {
      this.failed = true;
    }
  }
}

function findRootEntries(
  context: ShellCommandContext,
  root: string,
  expression: FindExpression,
): FindEntry[] {
  const normalized = commandPath(context, root);
  // A link named on the command line is reported but never descended into.
  const operand = context.fileSystem.lstat(normalized);
  if (operand.kind === "symlink") {
    context.budget.glob(1);
    return [{ stat: operand, display: displayPath(root, normalized, normalized), depth: 0 }];
  }
  const traversalRoot = context.fileSystem.realpath(normalized);
  const entries: FindEntry[] = [];
  for (const stat of boundedFind(context, { path: normalized, includeRoot: true })) {
    const depth = depthFrom(traversalRoot, stat.path);
    if (expression.maxDepth !== undefined && depth > expression.maxDepth) continue;
    entries.push({ stat, display: displayPath(root, traversalRoot, stat.path), depth });
  }
  return entries;
}

function findExecArgv(exec: FindExec, paths: readonly string[]): readonly string[] {
  if (exec.batch) return [...exec.argv.slice(0, -1), ...paths];
  return exec.argv.map((word) => word.split("{}").join(paths[0] ?? ""));
}

/** Walks subtrees and evaluates a GNU-style expression for each entry. */
export const findCommand = /* @__PURE__ */ defineApplet(FIND, async (context, argv, fds) => {
  const expression = new FindExpressionParser(FIND, argv).parse();
  const evaluator = new FindEvaluator(context, fds);
  try {
    for (const root of expression.roots) {
      for (const entry of findRootEntries(context, root, expression)) {
        if (entry.depth < expression.minDepth || evaluator.isPruned(entry.stat.path)) continue;
        if (expression.node !== undefined) await evaluator.evaluate(expression.node, entry);
      }
    }
    return await evaluator.finish();
  } finally {
    evaluator.abort();
  }
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

import { isVfsError, VfsError } from "../core/errors.js";
import { compareUtf8, normalizePath, normalizePathPreservingTrailingSlash } from "../core/path.js";
import { bodyToStream, readAllBytes } from "../vfs/streams.js";
import { evaluateArithmetic } from "./arithmetic.js";
import { ExecutionBudget, resolveShellLimits } from "./budget.js";
import { optindGeneration, ShellEnvironment } from "./environment.js";
import { ShellNounsetError } from "./errors.js";
import {
  expandAssignmentValue,
  expandCasePattern,
  expandScalarWord,
  expandWords,
  matchesCasePattern,
  type ExpansionRuntime,
} from "./expand.js";
import { createBytePipe, isDownstreamClosedError } from "./pipe.js";
import { shellInput } from "./input.js";
import {
  parseShellScript,
  type AndOrNode,
  type CommandNode,
  type ConditionalExpression,
  type CompoundCommandNode,
  type FunctionDefinitionNode,
  type PipelineNode,
  type ScriptNode,
  type SimpleCommandNode,
} from "./parser.js";
import { ScopedFileSystem } from "./policy.js";
import { applyRedirections } from "./redirection.js";
import type {
  ExecuteBytesResult,
  ExecuteStreamOptions,
  ExecuteTextOptions,
  ExecuteTextResult,
  ShellBudget,
  ShellCommand,
  ShellExecution,
  ShellFileDescriptors,
  ShellLimits,
  ShellLocalGetoptsFrame,
  ShellOptions,
  ShellPolicy,
  ShellSession,
  ShellSink,
} from "./types.js";

function emptyInput(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
}

function cloneSession(session: ShellSession): ShellSession {
  return {
    cwd: session.cwd,
    env: session.env instanceof ShellEnvironment
      ? session.env.clone()
      : new ShellEnvironment(session.env),
    args: [...session.args],
    lastExitCode: session.lastExitCode,
    exitRequested: false,
    requestedExitCode: 0,
    pipefail: session.pipefail,
    errexit: session.errexit === true,
    nounset: session.nounset === true,
    functions: new Map(session.functions),
    functionDepth: session.functionDepth,
    sourceDepth: session.sourceDepth,
    loopDepth: session.loopDepth,
    localFrames: session.localFrames.map((frame) => new Map(frame)),
    localGetoptsFrames: session.localGetoptsFrames.map((frame) => ({
      captured: frame.captured,
      state: frame.state === undefined ? undefined : { ...frame.state },
    })),
    getopts: session.getopts === undefined ? undefined : { ...session.getopts },
    flow: { type: "none" },
  };
}

function statusFor(error: VfsError): number {
  return error instanceof ShellNounsetError
    ? 1
    : error.code === "EINVAL" ? 2 : error.code === "EACCES" ? 126 : 1;
}

function formatError(error: VfsError): string {
  return `${error.path === undefined ? "" : `${error.path}: `}${error.message}`;
}

async function runIsolatedShellScope(
  run: () => Promise<EvaluationResult>,
  stderr: ShellSink,
): Promise<EvaluationResult> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ShellNounsetError)) throw error;
    await stderr.write(new TextEncoder().encode(`${formatError(error)}\n`));
    return evaluationResult(statusFor(error));
  }
}

async function closeDescriptors(fds: ShellFileDescriptors): Promise<void> {
  const results = await Promise.allSettled([fds[1].close(), fds[2].close()]);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed !== undefined) throw failed.reason;
}

async function abortRedirectedDescriptors(
  fds: ShellFileDescriptors,
  redirected: ReadonlySet<1 | 2>,
  reason: unknown,
): Promise<void> {
  await Promise.allSettled([
    redirected.has(1) ? fds[1].abort(reason) : fds[1].close(),
    redirected.has(2) ? fds[2].abort(reason) : fds[2].close(),
  ]);
}

interface Runtime {
  commands: ReadonlyMap<string, ShellCommand>;
  fileSystem: ScopedFileSystem;
  budget: ShellBudget;
  policy: ShellPolicy;
  signal: AbortSignal;
  limits: ShellLimits;
  parserBudget: ParserBudget;
}

interface EvaluationContext {
  readonly errexitSuppressed: boolean;
}

interface EvaluationResult {
  readonly status: number;
  readonly errexitEligible: boolean;
}

const ACTIVE_EVALUATION_CONTEXT: EvaluationContext = Object.freeze({
  errexitSuppressed: false,
});
const SUPPRESSED_EVALUATION_CONTEXT: EvaluationContext = Object.freeze({
  errexitSuppressed: true,
});

function suppressErrexit(context: EvaluationContext): EvaluationContext {
  return context.errexitSuppressed ? context : SUPPRESSED_EVALUATION_CONTEXT;
}

function evaluationResult(status: number, errexitEligible = true): EvaluationResult {
  return { status, errexitEligible };
}

function requestErrexit(
  status: number,
  session: ShellSession,
  context: EvaluationContext,
): void {
  if (status !== 0
    && session.errexit === true
    && !context.errexitSuppressed
    && !session.exitRequested
    && session.flow.type === "none") {
    session.flow = { type: "errexit" };
  }
}

interface ParserBudget {
  sourceBytes: number;
  astNodes: number;
}

function parseScriptUnit(
  source: string,
  limits: ShellLimits,
  budget: ParserBudget,
  executionBudget: Pick<ShellBudget, "checkDeadline">,
  path?: string,
): ScriptNode {
  const sourceBytes = new TextEncoder().encode(source).byteLength;
  if (sourceBytes > limits.maxScriptBytes) {
    throw new VfsError("E2BIG", "shell source exceeds the script byte limit", path);
  }
  if (budget.sourceBytes + sourceBytes > limits.maxTotalSourceBytes) {
    throw new VfsError("E2BIG", "shell total source byte limit exceeded", path);
  }
  budget.sourceBytes += sourceBytes;
  try {
    const parsed = parseShellScript(
      source,
      limits.maxAstNodes - budget.astNodes,
      limits.maxNestingDepth,
      (count) => { budget.astNodes += count; },
      () => executionBudget.checkDeadline(),
    );
    return parsed;
  } catch (error) {
    if (path === undefined || !isVfsError(error)) throw error;
    throw new VfsError(error.code, error.message, path);
  }
}

interface CollectedSubstitution {
  bytes: Uint8Array;
  release(): void;
}

async function collectSubstitutionOutput(
  stream: ReadableStream<Uint8Array>,
  runtime: Runtime,
): Promise<CollectedSubstitution> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  const chunkReleases: Array<() => void> = [];
  let total = 0;
  let releaseOutput: (() => void) | undefined;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > runtime.limits.maxCommandSubstitutionBytes) {
        throw new VfsError("E2BIG", "command substitution output limit exceeded");
      }
      const release = runtime.budget.buffered(result.value.byteLength);
      try {
        chunks.push(result.value.slice());
        chunkReleases.push(release);
      } catch (error) {
        release();
        throw error;
      }
    }
    releaseOutput = runtime.budget.buffered(total);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    chunks.length = 0;
    for (const release of chunkReleases.splice(0)) release();
    return { bytes, release: releaseOutput };
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    releaseOutput?.();
    throw error;
  } finally {
    for (const release of chunkReleases) release();
    reader.releaseLock();
  }
}

function redirections(node: CommandNode): readonly import("./parser.js").Redirection[] {
  return node.type === "function-definition" ? [] : node.redirections;
}

function expansionRuntime(fds: ShellFileDescriptors, runtime: Runtime): ExpansionRuntime {
  let lastStatus: number | undefined;
  return {
    async commandSubstitute(script, session) {
      const output = createBytePipe({
        maximumBytes: runtime.limits.maxCommandSubstitutionBytes,
        signal: runtime.signal,
        name: "command substitution",
        account: (bytes) => runtime.budget.io(bytes),
      });
      const child = cloneSession(session);
      child.errexit = false;
      const childFds: ShellFileDescriptors = {
        0: fds[0],
        1: output.sink,
        2: fds[2].clone(),
      };
      const completed = (async () => {
        try {
          return await runIsolatedShellScope(
            async () => await runScript(
              script,
              child,
              childFds,
              runtime,
              ACTIVE_EVALUATION_CONTEXT,
            ),
            fds[2],
          );
        } finally {
          await closeDescriptors(childFds);
        }
      })();
      let retained: CollectedSubstitution | undefined;
      try {
        const [collected, result] = await Promise.all([
          collectSubstitutionOutput(output.readable, runtime).then((value) => {
            retained = value;
            return value;
          }),
          completed,
        ]);
        lastStatus = result.status;
        let value: string;
        try {
          value = new TextDecoder("utf-8", { fatal: true }).decode(collected.bytes);
        } catch {
          throw new VfsError("EIO", "command substitution output is not valid UTF-8");
        }
        if (value.includes("\0")) throw new VfsError("EINVAL", "command substitution produced a NUL byte");
        return value.replace(/\n+$/u, "");
      } finally {
        retained?.release();
      }
    },
    lastSubstitutionStatus() {
      return lastStatus;
    },
  };
}

interface PreparedSimpleCommand {
  assignments: Array<{ name: string; value: string }>;
  argv: string[];
  substitutionStatus?: number;
}

async function prepareSimpleCommand(
  node: SimpleCommandNode,
  session: ShellSession,
  runtime: Runtime,
  expansion: ExpansionRuntime,
): Promise<PreparedSimpleCommand> {
  const assignments: Array<{ name: string; value: string }> = [];
  const assignmentSession = cloneSession(session);
  let wordIndex = 0;
  while (node.words[wordIndex]?.assignmentName !== undefined) {
    const word = node.words[wordIndex];
    if (word === undefined || word.assignmentName === undefined) break;
    const value = await expandAssignmentValue(
      word,
      word.assignmentName,
      assignmentSession,
      runtime.fileSystem,
      runtime.budget,
      expansion,
    );
    assignments.push({ name: word.assignmentName, value });
    assignmentSession.env.set(word.assignmentName, value);
    wordIndex += 1;
  }
  const assignmentNames = new Set(assignments.map((value) => value.name));
  for (const [name, value] of assignmentSession.env) {
    if (!assignmentNames.has(name) && session.env.get(name) !== value) session.env.set(name, value);
  }
  const argv = await expandWords(
    node.words.slice(wordIndex),
    session,
    runtime.fileSystem,
    runtime.budget,
    expansion,
  );
  return { assignments, argv };
}

function restoreVariables(
  session: ShellSession,
  previous: ReadonlyMap<string, string | undefined>,
  preserved: ReadonlySet<string>,
): void {
  for (const [name, value] of previous) {
    if (preserved.has(name)) continue;
    if (value === undefined) session.env.delete(name);
    else session.env.set(name, value);
  }
}

function restoreLocals(session: ShellSession, frame: ReadonlyMap<string, string | undefined>): void {
  for (const [name, value] of frame) {
    if (value === undefined) session.env.delete(name);
    else session.env.set(name, value);
  }
}

async function runFunction(
  definition: FunctionDefinitionNode,
  argv: readonly string[],
  session: ShellSession,
  fds: ShellFileDescriptors,
  runtime: Runtime,
  context: EvaluationContext,
): Promise<number> {
  if (session.functionDepth >= runtime.limits.maxFunctionDepth) {
    throw new VfsError("E2BIG", "shell function recursion limit exceeded");
  }
  const previousArgs = session.args;
  const frame = new Map<string, string | undefined>();
  const getoptsFrame: ShellLocalGetoptsFrame = { captured: false, state: undefined };
  session.args = [...argv];
  session.functionDepth += 1;
  session.localFrames.push(frame);
  session.localGetoptsFrames.push(getoptsFrame);
  try {
    let status = (await runCommandNode(
      definition.body,
      session,
      { 0: fds[0], 1: fds[1].clone(), 2: fds[2].clone() },
      runtime,
      false,
      context,
    )).status;
    if (session.flow.type === "return") {
      status = session.flow.status;
      session.flow = { type: "none" };
    }
    return status;
  } finally {
    session.localFrames.pop();
    session.localGetoptsFrames.pop();
    restoreLocals(session, frame);
    if (getoptsFrame.captured) {
      session.getopts = getoptsFrame.state === undefined
        ? undefined
        : { ...getoptsFrame.state, optindGeneration: optindGeneration(session.env) };
    }
    session.functionDepth -= 1;
    session.args = previousArgs;
  }
}

async function runSourcedUnit(
  source: string,
  path: string,
  args: readonly string[],
  session: ShellSession,
  fds: ShellFileDescriptors,
  runtime: Runtime,
  context: EvaluationContext,
): Promise<number> {
  if (session.sourceDepth >= runtime.limits.maxSourceDepth) {
    throw new VfsError("E2BIG", "shell source nesting limit exceeded", path);
  }
  const parsed = parseScriptUnit(source, runtime.limits, runtime.parserBudget, runtime.budget, path);
  const previousArgs = session.args;
  if (args.length > 0) session.args = [...args];
  session.sourceDepth += 1;
  try {
    let status = (await runScript(parsed, session, fds, runtime, context)).status;
    if (session.flow.type === "return") {
      status = session.flow.status;
      session.flow = { type: "none" };
    }
    return status;
  } finally {
    session.sourceDepth -= 1;
    if (args.length > 0) session.args = previousArgs;
  }
}

async function executeSimpleCommand(
  prepared: PreparedSimpleCommand,
  session: ShellSession,
  fds: ShellFileDescriptors,
  runtime: Runtime,
  context: EvaluationContext,
): Promise<number> {
  if (prepared.argv.length === 0) {
    for (const value of prepared.assignments) session.env.set(value.name, value.value);
    return prepared.substitutionStatus ?? 0;
  }
  const [name = "", ...argv] = prepared.argv;
  const definition = session.functions.get(name);
  if (definition === undefined && runtime.policy.allowedCommands !== undefined
    && !runtime.policy.allowedCommands.includes(name)) {
    throw new VfsError("EACCES", `command is not allowed: ${name}`);
  }
  const previous = new Map<string, string | undefined>();
  for (const value of prepared.assignments) {
    previous.set(value.name, session.env.get(value.name));
    session.env.set(value.name, value.value);
  }
  try {
    let exitCode: number;
    if (definition !== undefined) {
      exitCode = await runFunction(definition, argv, session, fds, runtime, context);
    } else {
      const command = runtime.commands.get(name);
      if (command === undefined) {
        await fds[2].write(new TextEncoder().encode(`${name}: command not found\n`));
        return 127;
      }
      exitCode = (await command.run(
        {
          fileSystem: runtime.fileSystem,
          session,
          signal: runtime.signal,
          budget: runtime.budget,
          policy: runtime.policy,
          executeSource: async (source, path, sourceArgs, sourceFds) =>
            await runSourcedUnit(source, path, sourceArgs, session, sourceFds, runtime, context),
        },
        argv,
        fds,
      ).completed).exitCode;
      if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
        throw new RangeError(`command ${name} returned an invalid exit status: ${exitCode}`);
      }
    }
    return exitCode;
  } finally {
    const preserved = name === "export"
      ? new Set(argv.map((value) => value.split("=", 1)[0] ?? ""))
      : new Set<string>();
    restoreVariables(session, previous, preserved);
  }
}

function consumeLoopFlow(session: ShellSession): "break" | "continue" | "propagate" | "none" {
  const flow = session.flow;
  if (flow.type !== "break" && flow.type !== "continue") return "none";
  if (flow.levels > 1) {
    session.flow = { type: flow.type, levels: flow.levels - 1 };
    return "propagate";
  }
  session.flow = { type: "none" };
  return flow.type;
}

function flowActive(session: ShellSession): boolean {
  return session.flow.type !== "none";
}

interface NormalizedConditionalInteger {
  negative: boolean;
  digits: string;
}

function normalizeConditionalInteger(
  value: string,
  budget: ShellBudget,
): NormalizedConditionalInteger {
  budget.expansionWork(value.length);
  if (!/^-?[0-9]+$/u.test(value)) {
    throw new VfsError("EINVAL", "[[: integer expression expected");
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const digits = unsigned.replace(/^0+/u, "") || "0";
  return { negative: negative && digits !== "0", digits };
}

function compareConditionalIntegers(
  left: string,
  right: string,
  budget: ShellBudget,
): number {
  const first = normalizeConditionalInteger(left, budget);
  const second = normalizeConditionalInteger(right, budget);
  if (first.negative !== second.negative) return first.negative ? -1 : 1;
  let order = first.digits.length - second.digits.length;
  if (order === 0 && first.digits !== second.digits) order = first.digits < second.digits ? -1 : 1;
  return first.negative ? -order : order;
}

async function evaluateConditional(
  expression: ConditionalExpression,
  session: ShellSession,
  runtime: Runtime,
  expansion: ExpansionRuntime,
): Promise<boolean> {
  type Pending =
    | { type: "not" }
    | { type: "boolean"; operator: "&&" | "||"; right: ConditionalExpression };
  const pending: Pending[] = [];
  let current = expression;

  evaluate: while (true) {
    runtime.budget.step();
    if (current.type === "conditional-not") {
      pending.push({ type: "not" });
      current = current.expression;
      continue;
    }
    if (current.type === "conditional-group") {
      current = current.expression;
      continue;
    }
    if (current.type === "conditional-boolean") {
      pending.push({ type: "boolean", operator: current.operator, right: current.right });
      current = current.left;
      continue;
    }

    let value: boolean;
    if (current.type === "conditional-word") {
      value = (await expandScalarWord(
        current.word,
        session,
        runtime.fileSystem,
        runtime.budget,
        expansion,
      )).length > 0;
    } else if (current.type === "conditional-unary") {
      const operand = await expandScalarWord(
        current.operand,
        session,
        runtime.fileSystem,
        runtime.budget,
        expansion,
      );
      if (current.operator === "-n") value = operand.length > 0;
      else if (current.operator === "-z") value = operand.length === 0;
      else if (operand.length === 0) value = false;
      else {
        try {
          const stat = await runtime.fileSystem.stat(
            normalizePathPreservingTrailingSlash(operand, session.cwd),
          );
          if (current.operator === "-e") value = true;
          else if (current.operator === "-f") value = stat.kind === "file";
          else value = stat.kind === "directory";
        } catch (error) {
          if (error instanceof VfsError && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
            value = false;
          } else throw error;
        }
      }
    } else {
      const left = await expandScalarWord(
        current.left,
        session,
        runtime.fileSystem,
        runtime.budget,
        expansion,
      );
      if (current.operator === "==" || current.operator === "!=") {
        const pattern = await expandCasePattern(
          current.right,
          session,
          runtime.fileSystem,
          runtime.budget,
          expansion,
        );
        const matches = matchesCasePattern(left, pattern, runtime.budget);
        value = current.operator === "==" ? matches : !matches;
      } else {
        const right = await expandScalarWord(
          current.right,
          session,
          runtime.fileSystem,
          runtime.budget,
          expansion,
        );
        if (current.operator === "<" || current.operator === ">") {
          runtime.budget.expansionWork(left.length + right.length);
          const order = compareUtf8(left, right);
          value = current.operator === "<" ? order < 0 : order > 0;
        } else {
          const order = compareConditionalIntegers(left, right, runtime.budget);
          if (current.operator === "-eq") value = order === 0;
          else if (current.operator === "-ne") value = order !== 0;
          else if (current.operator === "-lt") value = order < 0;
          else if (current.operator === "-le") value = order <= 0;
          else if (current.operator === "-gt") value = order > 0;
          else value = order >= 0;
        }
      }
    }

    while (true) {
      const frame = pending.pop();
      if (frame === undefined) return value;
      if (frame.type === "not") {
        value = !value;
        continue;
      }
      const shortCircuited = frame.operator === "&&" ? !value : value;
      if (shortCircuited) continue;
      current = frame.right;
      continue evaluate;
    }
  }
}

async function runLoopBody(
  body: ScriptNode,
  session: ShellSession,
  fds: ShellFileDescriptors,
  runtime: Runtime,
  context: EvaluationContext,
): Promise<{ result: EvaluationResult; action: "break" | "continue" | "propagate" | "none" }> {
  runtime.budget.loop();
  const result = await runScript(body, session, fds, runtime, context);
  return { result, action: consumeLoopFlow(session) };
}

async function executeCompoundCommand(
  node: CompoundCommandNode,
  session: ShellSession,
  fds: ShellFileDescriptors,
  runtime: Runtime,
  expansion: ExpansionRuntime,
  context: EvaluationContext,
): Promise<EvaluationResult> {
  switch (node.type) {
    case "group": {
      const target = node.subshell ? cloneSession(session) : session;
      const result = await runScript(node.body, target, fds, runtime, context);
      return node.subshell ? evaluationResult(result.status) : result;
    }
    case "if": {
      for (const branch of node.branches) {
        const condition = await runScript(
          branch.condition,
          session,
          fds,
          runtime,
          suppressErrexit(context),
        );
        if (session.exitRequested || session.flow.type !== "none") return condition;
        if (condition.status === 0) {
          return await runScript(branch.body, session, fds, runtime, context);
        }
      }
      return node.alternate === undefined
        ? evaluationResult(0)
        : await runScript(node.alternate, session, fds, runtime, context);
    }
    case "loop": {
      let result = evaluationResult(0);
      session.loopDepth += 1;
      try {
        while (true) {
          const condition = await runScript(
            node.condition,
            session,
            fds,
            runtime,
            suppressErrexit(context),
          );
          if (session.exitRequested || session.flow.type !== "none") return condition;
          if ((condition.status === 0) === node.until) break;
          const iteration = await runLoopBody(node.body, session, fds, runtime, context);
          result = iteration.result;
          if (iteration.action === "break") break;
          if (iteration.action === "propagate") return result;
          if (session.exitRequested || flowActive(session)) return result;
        }
        return result;
      } finally {
        session.loopDepth -= 1;
      }
    }
    case "for": {
      const values = node.words === undefined
        ? [...session.args]
        : await expandWords(node.words, session, runtime.fileSystem, runtime.budget, expansion);
      let result = evaluationResult(0);
      session.loopDepth += 1;
      try {
        for (const value of values) {
          session.env.set(node.name, value);
          const iteration = await runLoopBody(node.body, session, fds, runtime, context);
          result = iteration.result;
          if (iteration.action === "break") break;
          if (iteration.action === "propagate") return result;
          if (session.exitRequested || flowActive(session)) return result;
        }
        return result;
      } finally {
        session.loopDepth -= 1;
      }
    }
    case "case": {
      const value = await expandScalarWord(
        node.word,
        session,
        runtime.fileSystem,
        runtime.budget,
        expansion,
      );
      for (const clause of node.clauses) {
        for (const patternWord of clause.patterns) {
          const pattern = await expandCasePattern(
            patternWord,
            session,
            runtime.fileSystem,
            runtime.budget,
            expansion,
          );
          if (matchesCasePattern(value, pattern, runtime.budget)) {
            return await runScript(clause.body, session, fds, runtime, context);
          }
        }
      }
      return evaluationResult(0);
    }
    case "arithmetic-command": {
      return evaluationResult(
        evaluateArithmetic(node.expression, session.env, session.nounset === true) === 0n ? 1 : 0,
      );
    }
    case "double-bracket": {
      return evaluationResult(
        await evaluateConditional(node.expression, session, runtime, expansion) ? 0 : 1,
      );
    }
  }
}

async function executeCommandNode(
  node: CommandNode,
  prepared: PreparedSimpleCommand | undefined,
  session: ShellSession,
  fds: ShellFileDescriptors,
  runtime: Runtime,
  expansion: ExpansionRuntime,
  context: EvaluationContext,
): Promise<EvaluationResult> {
  if (node.type === "command") {
    if (prepared === undefined) throw new VfsError("EIO", "simple command was not expanded");
    return evaluationResult(await executeSimpleCommand(prepared, session, fds, runtime, context));
  }
  if (node.type === "function-definition") {
    session.functions.set(node.name, node);
    return evaluationResult(0);
  }
  return await executeCompoundCommand(node, session, fds, runtime, expansion, context);
}

async function runCommandNode(
  node: CommandNode,
  session: ShellSession,
  initialFds: ShellFileDescriptors,
  runtime: Runtime,
  cancelUnreadInput: boolean,
  context: EvaluationContext,
): Promise<EvaluationResult> {
  let fds = initialFds;
  let redirected: ReadonlySet<1 | 2> = new Set();
  const fallbackStderr = initialFds[2].clone();
  let semanticStderr = fallbackStderr;
  let semanticFailure = false;
  let shouldCancelInput = cancelUnreadInput;
  const expansion = expansionRuntime(initialFds, runtime);
  try {
    runtime.budget.command();
    let prepared = node.type === "command"
      ? await prepareSimpleCommand(node, session, runtime, expansion)
      : undefined;
    let applied;
    try {
      applied = await applyRedirections(
        redirections(node),
        fds,
        session,
        runtime.fileSystem,
        runtime.budget,
        cancelUnreadInput,
        expansion,
      );
    } catch (error) {
      fds = { 0: initialFds[0], 1: initialFds[1], 2: fallbackStderr };
      throw error;
    }
    fds = applied.fds;
    semanticStderr = fds[2];
    redirected = applied.redirected;
    shouldCancelInput ||= applied.inputRedirected;
    if (prepared !== undefined) {
      const substitutionStatus = expansion.lastSubstitutionStatus();
      if (substitutionStatus !== undefined) prepared = { ...prepared, substitutionStatus };
    }
    const status = await executeCommandNode(
      node,
      prepared,
      session,
      fds,
      runtime,
      expansion,
      context,
    );
    semanticStderr = fallbackStderr;
    await closeDescriptors(fds);
    return status;
  } catch (error) {
    if (isDownstreamClosedError(error)) {
      await Promise.allSettled([fds[1].close(), fds[2].close()]);
      return evaluationResult(0);
    }
    if (!isVfsError(error)) {
      await Promise.allSettled([fds[1].abort(error), fds[2].abort(error)]);
      throw error;
    }
    const fatal = error.code === "E2BIG" || error.code === "EFBIG"
      || error.code === "ETIMEDOUT" || error.code === "ECANCELED";
    if (fatal || error instanceof ShellNounsetError) {
      await abortRedirectedDescriptors(fds, redirected, error);
      throw error;
    }
    semanticFailure = true;
    const message = formatError(error);
    try {
      await semanticStderr.write(new TextEncoder().encode(`${message}\n`));
    } finally {
      await Promise.allSettled([fds[1].close(), fds[2].close()]);
    }
    return evaluationResult(statusFor(error));
  } finally {
    if (shouldCancelInput) {
      await fds[0].cancel(new VfsError("EPIPE", "command stopped reading input")).catch(() => undefined);
    }
    await fallbackStderr.close().catch(() => undefined);
    if (semanticFailure) runtime.budget.step();
  }
}

async function runPipeline(
  pipeline: PipelineNode,
  session: ShellSession,
  outerFds: ShellFileDescriptors,
  runtime: Runtime,
  context: EvaluationContext,
): Promise<EvaluationResult> {
  const stages: Array<{
    node: CommandNode;
    session: ShellSession;
    fds: ShellFileDescriptors;
    context: EvaluationContext;
  }> = [];
  const pipelineContext = pipeline.negated ? suppressErrexit(context) : context;
  let input = outerFds[0];
  for (const [index, node] of pipeline.commands.entries()) {
    const last = index === pipeline.commands.length - 1;
    let output: ShellSink;
    let nextInput: ReadableStream<Uint8Array> | undefined;
    if (last) output = outerFds[1].clone();
    else {
      const pipe = createBytePipe({
        maximumBytes: runtime.limits.maxPipelineBytes,
        signal: runtime.signal,
        name: `pipeline edge ${index + 1}`,
        account: (bytes) => runtime.budget.io(bytes),
      });
      output = pipe.sink;
      nextInput = shellInput(pipe.readable);
    }
    stages.push({
      node,
      session: pipeline.commands.length === 1 ? session : cloneSession(session),
      fds: { 0: input, 1: output, 2: outerFds[2].clone() },
      context: index === pipeline.commands.length - 1
        ? pipelineContext
        : suppressErrexit(pipelineContext),
    });
    if (nextInput !== undefined) input = nextInput;
  }
  const isolated = pipeline.commands.length > 1
    || (pipeline.commands[0]?.type === "group" && pipeline.commands[0].subshell);
  const results = await Promise.all(stages.map((stage, index) => isolated
    ? runIsolatedShellScope(
      async () => await runCommandNode(
        stage.node,
        stage.session,
        stage.fds,
        runtime,
        index > 0,
        stage.context,
      ),
      outerFds[2],
    )
    : runCommandNode(
      stage.node,
      stage.session,
      stage.fds,
      runtime,
      index > 0,
      stage.context,
    )));
  let selected = results.at(-1) ?? evaluationResult(0);
  if (session.pipefail) {
    for (let index = results.length - 1; index >= 0; index -= 1) {
      const candidate = results[index];
      if (candidate !== undefined && candidate.status !== 0) {
        selected = candidate;
        break;
      }
    }
  }
  const status = pipeline.negated ? (selected.status === 0 ? 1 : 0) : selected.status;
  const result = evaluationResult(
    status,
    !pipelineContext.errexitSuppressed
      && !pipeline.negated
      && (pipeline.commands.length > 1 || selected.errexitEligible),
  );
  session.lastExitCode = result.status;
  if (result.errexitEligible) requestErrexit(result.status, session, pipelineContext);
  return result;
}

async function runAndOr(
  node: AndOrNode,
  session: ShellSession,
  fds: ShellFileDescriptors,
  runtime: Runtime,
  context: EvaluationContext,
): Promise<EvaluationResult> {
  let result = await runPipeline(
    node.first,
    session,
    fds,
    runtime,
    node.rest.length === 0 ? context : suppressErrexit(context),
  );
  for (const [index, item] of node.rest.entries()) {
    if (session.exitRequested || session.flow.type !== "none") break;
    if ((item.operator === "&&" && result.status === 0)
      || (item.operator === "||" && result.status !== 0)) {
      result = await runPipeline(
        item.pipeline,
        session,
        fds,
        runtime,
        index === node.rest.length - 1 ? context : suppressErrexit(context),
      );
    }
  }
  return result;
}

async function runScript(
  script: ScriptNode,
  session: ShellSession,
  fds: ShellFileDescriptors,
  runtime: Runtime,
  context: EvaluationContext = ACTIVE_EVALUATION_CONTEXT,
): Promise<EvaluationResult> {
  let result = evaluationResult(0);
  for (const list of script.lists) {
    runtime.budget.step();
    result = await runAndOr(list, session, fds, runtime, context);
    session.lastExitCode = result.status;
    if (session.exitRequested) return evaluationResult(session.requestedExitCode);
    if (session.flow.type !== "none") return result;
  }
  return result;
}

export class Shell {
  private readonly commands: ReadonlyMap<string, ShellCommand>;
  private readonly fileSystem: ShellOptions["fileSystem"];
  private readonly policy: ShellPolicy;
  private readonly limits: ShellLimits;
  private readonly now: () => number;

  constructor(options: ShellOptions) {
    const commands = new Map<string, ShellCommand>();
    for (const command of options.commands) {
      if (commands.has(command.name)) throw new VfsError("EINVAL", `duplicate command: ${command.name}`);
      commands.set(command.name, command);
    }
    this.commands = commands;
    this.fileSystem = options.fileSystem;
    this.policy = Object.freeze({
      ...(options.policy?.readRoots === undefined
        ? {}
        : { readRoots: Object.freeze(options.policy.readRoots.map((path) => normalizePath(path))) }),
      ...(options.policy?.writeRoots === undefined
        ? {}
        : { writeRoots: Object.freeze(options.policy.writeRoots.map((path) => normalizePath(path))) }),
      ...(options.policy?.allowedCommands === undefined
        ? {}
        : { allowedCommands: Object.freeze([...options.policy.allowedCommands]) }),
      ...(options.policy?.maxMutations === undefined
        ? {}
        : { maxMutations: options.policy.maxMutations }),
    });
    this.limits = Object.freeze(resolveShellLimits({
      ...options.limits,
      ...(options.policy?.maxMutations === undefined
        ? {}
        : { maxMutations: options.policy.maxMutations }),
    }));
    this.now = options.now ?? Date.now;
  }

  executeStream(options: ExecuteStreamOptions): ShellExecution {
    const parserBudget: ParserBudget = { sourceBytes: 0, astNodes: 0 };
    const budget = new ExecutionBudget(this.limits, this.now);
    let parsed: ScriptNode | undefined;
    let parseError: VfsError | undefined;
    try {
      parsed = parseScriptUnit(options.script, this.limits, parserBudget, budget);
    } catch (error) {
      if (!isVfsError(error)) throw error;
      parseError = error;
    }
    const controller = new AbortController();
    const cancelled = (reason: unknown): VfsError => isVfsError(reason)
      ? reason
      : new VfsError("ECANCELED", "execution was cancelled");
    let externalAbort: (() => void) | undefined;
    if (options.signal !== undefined) {
      externalAbort = () => controller.abort(cancelled(options.signal?.reason));
      if (options.signal.aborted) externalAbort();
      else options.signal.addEventListener("abort", externalAbort, { once: true });
    }
    const scoped = new ScopedFileSystem(this.fileSystem, this.policy, budget);
    const stdout = createBytePipe({
      maximumBytes: this.limits.maxStdoutBytes,
      signal: controller.signal,
      name: "stdout",
      account: (bytes) => budget.io(bytes),
      idleTimeoutMs: this.limits.outputIdleTimeoutMs,
      onIdle: () => controller.abort(new VfsError(
        "ETIMEDOUT",
        "stdout consumer did not relieve backpressure",
      )),
      onConsumerCancel: (reason) => controller.abort(cancelled(reason)),
    });
    const stderr = createBytePipe({
      maximumBytes: this.limits.maxStderrBytes,
      signal: controller.signal,
      name: "stderr",
      account: (bytes) => budget.io(bytes),
      idleTimeoutMs: this.limits.outputIdleTimeoutMs,
      onIdle: () => controller.abort(new VfsError(
        "ETIMEDOUT",
        "stderr consumer did not relieve backpressure",
      )),
      onConsumerCancel: (reason) => controller.abort(cancelled(reason)),
    });
    const session: ShellSession = {
      cwd: normalizePath(options.cwd ?? "/"),
      env: new ShellEnvironment(Object.entries(options.env ?? {})),
      args: [...(options.args ?? [])],
      lastExitCode: 0,
      exitRequested: false,
      requestedExitCode: 0,
      pipefail: false,
      errexit: false,
      nounset: false,
      functions: new Map(),
      functionDepth: 0,
      sourceDepth: 0,
      loopDepth: 0,
      localFrames: [],
      localGetoptsFrames: [],
      getopts: undefined,
      flow: { type: "none" },
    };
    session.env.set("PWD", session.cwd);
    session.env.set("0", session.env.get("0") ?? "cf-vfs");
    session.env.set("IFS", " \t\n");
    if (!session.env.has("OPTIND")) session.env.set("OPTIND", "1");
    session.env.set("LC_ALL", "C");
    session.env.set("TZ", "UTC");
    const timeout = setTimeout(() => {
      controller.abort(new VfsError("ETIMEDOUT", "shell execution deadline exceeded"));
    }, budget.remainingDeadlineMs());
    const rootFds: ShellFileDescriptors = {
      0: shellInput(options.stdin ?? emptyInput()),
      1: stdout.sink,
      2: stderr.sink,
    };
    const completed = (async () => {
      try {
        if (parseError !== undefined) {
          await rootFds[2].write(new TextEncoder().encode(`${parseError.message}\n`));
          await closeDescriptors(rootFds);
          return { exitCode: parseError.code === "EINVAL" ? 2 : 1 };
        }
        if (parsed === undefined) throw new VfsError("EIO", "parser produced no script");
        const result = await runScript(parsed, session, rootFds, {
          commands: this.commands,
          fileSystem: scoped,
          budget,
          policy: this.policy,
          signal: controller.signal,
          limits: this.limits,
          parserBudget,
        });
        await closeDescriptors(rootFds);
        return { exitCode: result.status };
      } catch (error) {
        if (!isVfsError(error)) {
          await Promise.allSettled([rootFds[1].abort(error), rootFds[2].abort(error)]);
          throw error;
        }
        const message = formatError(error);
        if (!controller.signal.aborted || error.code === "ETIMEDOUT") {
          try {
            await rootFds[2].write(new TextEncoder().encode(`${message}\n`));
          } catch {
            // The caller may have cancelled stderr too.
          }
        }
        await Promise.allSettled([rootFds[1].close(), rootFds[2].close()]);
        return { exitCode: statusFor(error) };
      } finally {
        const inputReason = controller.signal.reason
          ?? new VfsError("EPIPE", "shell execution stopped reading input");
        await rootFds[0].cancel(inputReason).catch(() => undefined);
        clearTimeout(timeout);
        if (externalAbort !== undefined) options.signal?.removeEventListener("abort", externalAbort);
      }
    })();
    return {
      stdout: stdout.readable,
      stderr: stderr.readable,
      completed,
      cancel(reason) {
        controller.abort(cancelled(reason));
      },
    };
  }

  async executeText(options: ExecuteTextOptions): Promise<ExecuteTextResult> {
    const result = await this.executeBytes(options);
    return {
      exitCode: result.exitCode,
      stdout: new TextDecoder().decode(result.stdoutBytes),
      stderr: new TextDecoder().decode(result.stderrBytes),
    };
  }

  async executeBytes(options: ExecuteTextOptions): Promise<ExecuteBytesResult> {
    const { stdin: input, ...streamOptions } = options;
    const stdin = typeof input === "string" || input instanceof Uint8Array
      ? bodyToStream(input)
      : input;
    const execution = this.executeStream({
      ...streamOptions,
      ...(stdin === undefined ? {} : { stdin }),
    });
    const collectOutput = async (
      stream: ReadableStream<Uint8Array>,
      maximumBytes: number,
    ): Promise<Uint8Array> => {
      try {
        return await readAllBytes(stream, maximumBytes);
      } catch (error) {
        if (isVfsError(error)) return new Uint8Array();
        throw error;
      }
    };
    const [stdoutBytes, stderrBytes, result] = await Promise.all([
      collectOutput(execution.stdout, this.limits.maxStdoutBytes),
      collectOutput(execution.stderr, this.limits.maxStderrBytes),
      execution.completed,
    ]);
    if (stdoutBytes.byteLength + stderrBytes.byteLength > this.limits.maxMaterializedOutputBytes) {
      return {
        exitCode: 1,
        stdoutBytes: new Uint8Array(),
        stderrBytes: new Uint8Array(),
      };
    }
    return {
      exitCode: result.exitCode,
      stdoutBytes,
      stderrBytes,
    };
  }
}

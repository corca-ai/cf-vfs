import { isVfsError, VfsError } from "../core/errors.js";
import { encodeUtf8 } from "../core/unicode.js";
import { evaluateArithmetic } from "./arithmetic.js";
import { ShellNounsetError } from "./errors.js";
import {
  type ExpansionRuntime,
  expandCasePattern,
  expandScalarWord,
  expandWords,
  matchesCasePattern,
} from "./expand.js";
import { shellInput } from "./input.js";
import type {
  AndOrNode,
  CommandNode,
  CompoundCommandNode,
  PipelineNode,
  ScriptNode,
} from "./parser.js";
import { createBytePipe, isDownstreamClosedError } from "./pipe.js";
import { type AppliedRedirections, applyRedirections } from "./redirection.js";
import { cloneShellSession } from "./session.js";
import { consumeLoopFlow, evaluateConditional, flowActive } from "./shell-condition.js";
import { executeSimpleCommand } from "./shell-execute.js";
import { type PreparedSimpleCommand, prepareSimpleCommand } from "./shell-resolve.js";
import type { Runtime } from "./shell-runtime.js";
import {
  ACTIVE_EVALUATION_CONTEXT,
  abortRedirectedDescriptors,
  closeDescriptors,
  type EvaluationContext,
  type EvaluationResult,
  evaluationResult,
  expansionRuntime,
  formatError,
  redirections,
  requestErrexit,
  runIsolatedShellScope,
  statusFor,
  suppressErrexit,
} from "./shell-runtime.js";
import type { ShellFileDescriptors, ShellSession, ShellSink } from "./types.js";

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

type CompoundNode<Type extends CompoundCommandNode["type"]> = Extract<
  CompoundCommandNode,
  { type: Type }
>;

async function executeGroup(
  node: CompoundNode<"group">,
  session: ShellSession,
  fds: ShellFileDescriptors,
  runtime: Runtime,
  context: EvaluationContext,
): Promise<EvaluationResult> {
  const target = node.subshell ? cloneShellSession(session) : session;
  const result = await runScript(node.body, target, fds, runtime, context);
  return node.subshell ? evaluationResult(result.status) : result;
}

async function executeIf(
  node: CompoundNode<"if">,
  session: ShellSession,
  fds: ShellFileDescriptors,
  runtime: Runtime,
  context: EvaluationContext,
): Promise<EvaluationResult> {
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

async function executeLoop(
  node: CompoundNode<"loop">,
  session: ShellSession,
  fds: ShellFileDescriptors,
  runtime: Runtime,
  context: EvaluationContext,
): Promise<EvaluationResult> {
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
      if ((condition.status === 0) === node.until) return result;
      const iteration = await runLoopBody(node.body, session, fds, runtime, context);
      result = iteration.result;
      if (iteration.action === "break") return result;
      if (iteration.action === "propagate") return result;
      if (session.exitRequested || flowActive(session)) return result;
    }
  } finally {
    session.loopDepth -= 1;
  }
}

async function executeFor(
  node: CompoundNode<"for">,
  session: ShellSession,
  fds: ShellFileDescriptors,
  runtime: Runtime,
  expansion: ExpansionRuntime,
  context: EvaluationContext,
): Promise<EvaluationResult> {
  const values =
    node.words === undefined
      ? [...session.args]
      : await expandWords(node.words, session, runtime.fileSystem, runtime.budget, expansion);
  let result = evaluationResult(0);
  session.loopDepth += 1;
  try {
    for (const value of values) {
      session.env.set(node.name, value);
      const iteration = await runLoopBody(node.body, session, fds, runtime, context);
      result = iteration.result;
      if (iteration.action === "break") return result;
      if (iteration.action === "propagate") return result;
      if (session.exitRequested || flowActive(session)) return result;
    }
    return result;
  } finally {
    session.loopDepth -= 1;
  }
}

async function executeCase(
  node: CompoundNode<"case">,
  session: ShellSession,
  fds: ShellFileDescriptors,
  runtime: Runtime,
  expansion: ExpansionRuntime,
  context: EvaluationContext,
): Promise<EvaluationResult> {
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

async function executeCompoundCommand(
  node: CompoundCommandNode,
  session: ShellSession,
  fds: ShellFileDescriptors,
  runtime: Runtime,
  expansion: ExpansionRuntime,
  context: EvaluationContext,
): Promise<EvaluationResult> {
  if (node.type === "group") return await executeGroup(node, session, fds, runtime, context);
  if (node.type === "if") return await executeIf(node, session, fds, runtime, context);
  if (node.type === "loop") return await executeLoop(node, session, fds, runtime, context);
  if (node.type === "for") return await executeFor(node, session, fds, runtime, expansion, context);
  if (node.type === "case")
    return await executeCase(node, session, fds, runtime, expansion, context);
  if (node.type === "arithmetic-command") {
    const value = evaluateArithmetic(node.expression, session.env, session.nounset === true);
    return evaluationResult(value === 0n ? 1 : 0);
  }
  const matches = await evaluateConditional(node.expression, session, runtime, expansion);
  return evaluationResult(matches ? 0 : 1);
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

interface CommandFailure {
  readonly result: EvaluationResult;
  readonly semanticFailure: boolean;
}

const FATAL_COMMAND_ERRORS: ReadonlySet<string> = new Set([
  "E2BIG",
  "EFBIG",
  "ETIMEDOUT",
  "ECANCELED",
]);

function isFatalCommandError(error: VfsError): boolean {
  return FATAL_COMMAND_ERRORS.has(error.code);
}

async function handleCommandError(
  error: unknown,
  fds: ShellFileDescriptors,
  redirected: ReadonlySet<1 | 2>,
  semanticStderr: ShellSink,
): Promise<CommandFailure> {
  if (isDownstreamClosedError(error)) {
    await Promise.allSettled([fds[1].close(), fds[2].close()]);
    return { result: evaluationResult(0), semanticFailure: false };
  }
  if (!isVfsError(error)) {
    await Promise.allSettled([fds[1].abort(error), fds[2].abort(error)]);
    throw error;
  }
  if (isFatalCommandError(error) || error instanceof ShellNounsetError) {
    await abortRedirectedDescriptors(fds, redirected, error);
    throw error;
  }
  try {
    await semanticStderr.write(encodeUtf8(`${formatError(error)}\n`));
  } finally {
    await Promise.allSettled([fds[1].close(), fds[2].close()]);
  }
  return { result: evaluationResult(statusFor(error)), semanticFailure: true };
}

export async function runCommandNode(
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
    let prepared =
      node.type === "command"
        ? await prepareSimpleCommand(node, session, runtime, expansion)
        : undefined;
    let applied: AppliedRedirections;
    try {
      applied = await applyRedirections(
        redirections(node),
        fds,
        session,
        runtime.fileSystem,
        runtime.budget,
        cancelUnreadInput,
        expansion,
        {
          content: runtime.content,
          access: runtime.policy.opaqueContent,
          signal: runtime.signal,
        },
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
    const failure = await handleCommandError(error, fds, redirected, semanticStderr);
    semanticFailure = failure.semanticFailure;
    return failure.result;
  } finally {
    if (shouldCancelInput) {
      await fds[0]
        .cancel(new VfsError("EPIPE", "command stopped reading input"))
        .catch(() => undefined);
    }
    await fallbackStderr.close().catch(() => undefined);
    if (semanticFailure) runtime.budget.step();
  }
}

interface PipelineStage {
  readonly node: CommandNode;
  readonly session: ShellSession;
  readonly fds: ShellFileDescriptors;
  readonly context: EvaluationContext;
}

function buildPipelineStages(
  pipeline: PipelineNode,
  session: ShellSession,
  outerFds: ShellFileDescriptors,
  runtime: Runtime,
  pipelineContext: EvaluationContext,
): PipelineStage[] {
  const stages: PipelineStage[] = [];
  let input = outerFds[0];
  for (const [index, node] of pipeline.commands.entries()) {
    const last = index === pipeline.commands.length - 1;
    const pipe = last
      ? undefined
      : createBytePipe({
          maximumBytes: runtime.limits.maxPipelineBytes,
          signal: runtime.signal,
          name: `pipeline edge ${index + 1}`,
          account: (bytes) => runtime.budget.io(bytes),
        });
    stages.push({
      node,
      session: pipeline.commands.length === 1 ? session : cloneShellSession(session),
      fds: { 0: input, 1: pipe?.sink ?? outerFds[1].clone(), 2: outerFds[2].clone() },
      context: last ? pipelineContext : suppressErrexit(pipelineContext),
    });
    if (pipe !== undefined) input = shellInput(pipe.readable);
  }
  return stages;
}

async function runPipelineStages(
  stages: readonly PipelineStage[],
  isolated: boolean,
  outerStderr: ShellSink,
  runtime: Runtime,
): Promise<EvaluationResult[]> {
  return await Promise.all(
    stages.map((stage, index) => {
      const run = async () =>
        await runCommandNode(
          stage.node,
          stage.session,
          stage.fds,
          runtime,
          index > 0,
          stage.context,
        );
      return isolated ? runIsolatedShellScope(run, outerStderr) : run();
    }),
  );
}

function selectPipelineResult(
  results: readonly EvaluationResult[],
  pipefail: boolean,
): EvaluationResult {
  if (pipefail) {
    for (let index = results.length - 1; index >= 0; index -= 1) {
      const candidate = results[index];
      if (candidate !== undefined && candidate.status !== 0) return candidate;
    }
  }
  return results.at(-1) ?? evaluationResult(0);
}

async function runPipeline(
  pipeline: PipelineNode,
  session: ShellSession,
  outerFds: ShellFileDescriptors,
  runtime: Runtime,
  context: EvaluationContext,
): Promise<EvaluationResult> {
  const pipelineContext = pipeline.negated ? suppressErrexit(context) : context;
  const stages = buildPipelineStages(pipeline, session, outerFds, runtime, pipelineContext);
  const isolated =
    pipeline.commands.length > 1 ||
    (pipeline.commands[0]?.type === "group" && pipeline.commands[0].subshell);
  const results = await runPipelineStages(stages, isolated, outerFds[2], runtime);
  const selected = selectPipelineResult(results, session.pipefail);
  const status = pipeline.negated ? (selected.status === 0 ? 1 : 0) : selected.status;
  const result = evaluationResult(
    status,
    !pipelineContext.errexitSuppressed &&
      !pipeline.negated &&
      (pipeline.commands.length > 1 || selected.errexitEligible),
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
    if (
      (item.operator === "&&" && result.status === 0) ||
      (item.operator === "||" && result.status !== 0)
    ) {
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

export async function runScript(
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

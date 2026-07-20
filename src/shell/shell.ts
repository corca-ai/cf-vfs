import { isVfsError, VfsError } from "../core/errors.js";
import { normalizePath } from "../core/path.js";
import { bodyToStream, readAllBytes } from "../vfs/streams.js";
import { evaluateArithmetic } from "./arithmetic.js";
import { ExecutionBudget, resolveShellLimits } from "./budget.js";
import {
  expandAssignmentValue,
  expandCasePattern,
  expandScalarWord,
  expandWords,
  matchesCasePattern,
  type ExpansionRuntime,
} from "./expand.js";
import { createBytePipe, isDownstreamClosedError } from "./pipe.js";
import {
  parseShellScript,
  type AndOrNode,
  type CommandNode,
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
    env: new Map(session.env),
    args: [...session.args],
    lastExitCode: session.lastExitCode,
    exitRequested: false,
    requestedExitCode: 0,
    pipefail: session.pipefail,
    functions: new Map(session.functions),
    functionDepth: session.functionDepth,
    sourceDepth: session.sourceDepth,
    loopDepth: session.loopDepth,
    localFrames: session.localFrames.map((frame) => new Map(frame)),
    flow: { type: "none" },
  };
}

function statusFor(error: VfsError): number {
  return error.code === "EINVAL" ? 2 : error.code === "EACCES" ? 126 : 1;
}

function formatError(error: VfsError): string {
  return `${error.path === undefined ? "" : `${error.path}: `}${error.message}`;
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

interface ParserBudget {
  sourceBytes: number;
  astNodes: number;
}

function parseScriptUnit(
  source: string,
  limits: ShellLimits,
  budget: ParserBudget,
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
      const childFds: ShellFileDescriptors = {
        0: fds[0],
        1: output.sink,
        2: fds[2].clone(),
      };
      const completed = (async () => {
        try {
          return await runScript(script, child, childFds, runtime);
        } finally {
          await closeDescriptors(childFds);
        }
      })();
      let retained: CollectedSubstitution | undefined;
      try {
        const [collected, status] = await Promise.all([
          collectSubstitutionOutput(output.readable, runtime).then((value) => {
            retained = value;
            return value;
          }),
          completed,
        ]);
        lastStatus = status;
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
  const substitutionStatus = expansion.lastSubstitutionStatus();
  return {
    assignments,
    argv,
    ...(substitutionStatus === undefined ? {} : { substitutionStatus }),
  };
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
): Promise<number> {
  if (session.functionDepth >= runtime.limits.maxFunctionDepth) {
    throw new VfsError("E2BIG", "shell function recursion limit exceeded");
  }
  const previousArgs = session.args;
  const frame = new Map<string, string | undefined>();
  session.args = [...argv];
  session.functionDepth += 1;
  session.localFrames.push(frame);
  try {
    let status = await runCommandNode(
      definition.body,
      session,
      { 0: fds[0], 1: fds[1].clone(), 2: fds[2].clone() },
      runtime,
      false,
    );
    if (session.flow.type === "return") {
      status = session.flow.status;
      session.flow = { type: "none" };
    }
    return status;
  } finally {
    session.localFrames.pop();
    restoreLocals(session, frame);
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
): Promise<number> {
  if (session.sourceDepth >= runtime.limits.maxSourceDepth) {
    throw new VfsError("E2BIG", "shell source nesting limit exceeded", path);
  }
  const parsed = parseScriptUnit(source, runtime.limits, runtime.parserBudget, path);
  const previousArgs = session.args;
  if (args.length > 0) session.args = [...args];
  session.sourceDepth += 1;
  try {
    let status = await runScript(parsed, session, fds, runtime);
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
      exitCode = await runFunction(definition, argv, session, fds, runtime);
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
            await runSourcedUnit(source, path, sourceArgs, session, sourceFds, runtime),
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

async function runLoopBody(
  body: ScriptNode,
  session: ShellSession,
  fds: ShellFileDescriptors,
  runtime: Runtime,
): Promise<{ status: number; action: "break" | "continue" | "propagate" | "none" }> {
  runtime.budget.loop();
  const status = await runScript(body, session, fds, runtime);
  return { status, action: consumeLoopFlow(session) };
}

async function executeCompoundCommand(
  node: CompoundCommandNode,
  session: ShellSession,
  fds: ShellFileDescriptors,
  runtime: Runtime,
  expansion: ExpansionRuntime,
): Promise<number> {
  switch (node.type) {
    case "group": {
      const target = node.subshell ? cloneSession(session) : session;
      return await runScript(node.body, target, fds, runtime);
    }
    case "if": {
      for (const branch of node.branches) {
        const condition = await runScript(branch.condition, session, fds, runtime);
        if (session.exitRequested || session.flow.type !== "none") return condition;
        if (condition === 0) return await runScript(branch.body, session, fds, runtime);
      }
      return node.alternate === undefined ? 0 : await runScript(node.alternate, session, fds, runtime);
    }
    case "loop": {
      let status = 0;
      session.loopDepth += 1;
      try {
        while (true) {
          const condition = await runScript(node.condition, session, fds, runtime);
          if (session.exitRequested || session.flow.type !== "none") return condition;
          if ((condition === 0) === node.until) break;
          const result = await runLoopBody(node.body, session, fds, runtime);
          status = result.status;
          if (result.action === "break") break;
          if (result.action === "propagate") return status;
          if (session.exitRequested || flowActive(session)) return status;
        }
        return status;
      } finally {
        session.loopDepth -= 1;
      }
    }
    case "for": {
      const values = node.words === undefined
        ? [...session.args]
        : await expandWords(node.words, session, runtime.fileSystem, runtime.budget, expansion);
      let status = 0;
      session.loopDepth += 1;
      try {
        for (const value of values) {
          session.env.set(node.name, value);
          const result = await runLoopBody(node.body, session, fds, runtime);
          status = result.status;
          if (result.action === "break") break;
          if (result.action === "propagate") return status;
          if (session.exitRequested || flowActive(session)) return status;
        }
        return status;
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
          if (matchesCasePattern(value, pattern)) return await runScript(clause.body, session, fds, runtime);
        }
      }
      return 0;
    }
    case "arithmetic-command": {
      return evaluateArithmetic(node.expression, session.env) === 0n ? 1 : 0;
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
): Promise<number> {
  if (node.type === "command") {
    if (prepared === undefined) throw new VfsError("EIO", "simple command was not expanded");
    return await executeSimpleCommand(prepared, session, fds, runtime);
  }
  if (node.type === "function-definition") {
    session.functions.set(node.name, node);
    return 0;
  }
  return await executeCompoundCommand(node, session, fds, runtime, expansion);
}

async function runCommandNode(
  node: CommandNode,
  session: ShellSession,
  initialFds: ShellFileDescriptors,
  runtime: Runtime,
  cancelUnreadInput: boolean,
): Promise<number> {
  let fds = initialFds;
  let redirected: ReadonlySet<1 | 2> = new Set();
  const fallbackStderr = initialFds[2].clone();
  let semanticFailure = false;
  let shouldCancelInput = cancelUnreadInput;
  const expansion = expansionRuntime(initialFds, runtime);
  try {
    runtime.budget.command();
    const prepared = node.type === "command"
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
    redirected = applied.redirected;
    shouldCancelInput ||= applied.inputRedirected;
    const status = await executeCommandNode(node, prepared, session, fds, runtime, expansion);
    await closeDescriptors(fds);
    return status;
  } catch (error) {
    if (isDownstreamClosedError(error)) {
      await Promise.allSettled([fds[1].close(), fds[2].close()]);
      return 0;
    }
    if (!isVfsError(error)) {
      await Promise.allSettled([fds[1].abort(error), fds[2].abort(error)]);
      throw error;
    }
    const fatal = error.code === "E2BIG" || error.code === "EFBIG"
      || error.code === "ETIMEDOUT" || error.code === "ECANCELED";
    if (fatal) {
      await abortRedirectedDescriptors(fds, redirected, error);
      throw error;
    }
    semanticFailure = true;
    const message = formatError(error);
    try {
      await fallbackStderr.write(new TextEncoder().encode(`${message}\n`));
    } finally {
      await Promise.allSettled([fds[1].close(), fds[2].close()]);
    }
    return statusFor(error);
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
): Promise<number> {
  const stages: Array<{
    node: CommandNode;
    session: ShellSession;
    fds: ShellFileDescriptors;
  }> = [];
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
      nextInput = pipe.readable;
    }
    stages.push({
      node,
      session: pipeline.commands.length === 1 ? session : cloneSession(session),
      fds: { 0: input, 1: output, 2: outerFds[2].clone() },
    });
    if (nextInput !== undefined) input = nextInput;
  }
  const statuses = await Promise.all(stages.map((stage, index) =>
    runCommandNode(stage.node, stage.session, stage.fds, runtime, index > 0)));
  let status = statuses.at(-1) ?? 0;
  if (session.pipefail) {
    for (let index = statuses.length - 1; index >= 0; index -= 1) {
      const candidate = statuses[index] ?? 0;
      if (candidate !== 0) {
        status = candidate;
        break;
      }
    }
  }
  if (pipeline.negated) status = status === 0 ? 1 : 0;
  session.lastExitCode = status;
  return status;
}

async function runAndOr(
  node: AndOrNode,
  session: ShellSession,
  fds: ShellFileDescriptors,
  runtime: Runtime,
): Promise<number> {
  let status = await runPipeline(node.first, session, fds, runtime);
  for (const item of node.rest) {
    if (session.exitRequested || session.flow.type !== "none") break;
    if ((item.operator === "&&" && status === 0) || (item.operator === "||" && status !== 0)) {
      status = await runPipeline(item.pipeline, session, fds, runtime);
    }
  }
  return status;
}

async function runScript(
  script: ScriptNode,
  session: ShellSession,
  fds: ShellFileDescriptors,
  runtime: Runtime,
): Promise<number> {
  let status = 0;
  for (const list of script.lists) {
    runtime.budget.step();
    status = await runAndOr(list, session, fds, runtime);
    session.lastExitCode = status;
    if (session.exitRequested) return session.requestedExitCode;
    if (session.flow.type !== "none") return status;
  }
  return status;
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
    let parsed: ScriptNode | undefined;
    let parseError: VfsError | undefined;
    try {
      parsed = parseScriptUnit(options.script, this.limits, parserBudget);
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
    const budget = new ExecutionBudget(this.limits, this.now);
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
      env: new Map(Object.entries(options.env ?? {})),
      args: [...(options.args ?? [])],
      lastExitCode: 0,
      exitRequested: false,
      requestedExitCode: 0,
      pipefail: false,
      functions: new Map(),
      functionDepth: 0,
      sourceDepth: 0,
      loopDepth: 0,
      localFrames: [],
      flow: { type: "none" },
    };
    session.env.set("PWD", session.cwd);
    session.env.set("0", session.env.get("0") ?? "cf-vfs");
    session.env.set("IFS", " \t\n");
    session.env.set("LC_ALL", "C");
    session.env.set("TZ", "UTC");
    const timeout = setTimeout(() => {
      controller.abort(new VfsError("ETIMEDOUT", "shell execution deadline exceeded"));
    }, this.limits.deadlineMs);
    const rootFds: ShellFileDescriptors = {
      0: options.stdin ?? emptyInput(),
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
        const exitCode = await runScript(parsed, session, rootFds, {
          commands: this.commands,
          fileSystem: scoped,
          budget,
          policy: this.policy,
          signal: controller.signal,
          limits: this.limits,
          parserBudget,
        });
        await closeDescriptors(rootFds);
        return { exitCode };
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
        return { exitCode: error.code === "EINVAL" ? 2 : 1 };
      } finally {
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

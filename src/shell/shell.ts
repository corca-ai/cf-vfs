import { isVfsError, VfsError } from "../core/errors.js";
import { normalizePath } from "../core/path.js";
import { bodyToStream, readAllBytes } from "../vfs/streams.js";
import { ExecutionBudget, resolveShellLimits } from "./budget.js";
import { expandAssignmentValue, expandWords } from "./expand.js";
import { createBytePipe, isDownstreamClosedError } from "./pipe.js";
import { parseShellScript, type AndOrNode, type PipelineNode, type ScriptNode, type SimpleCommandNode } from "./parser.js";
import { ScopedFileSystem } from "./policy.js";
import { applyRedirections } from "./redirection.js";
import type {
  ExecuteStreamOptions,
  ExecuteBytesResult,
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
  };
}

function statusFor(error: VfsError): number {
  return error.code === "EINVAL" ? 2 : error.code === "EACCES" ? 126 : 1;
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
}

async function runSimpleCommand(
  node: SimpleCommandNode,
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
  try {
    runtime.budget.command();
    const assignments: Array<{ name: string; value: string }> = [];
    const assignmentSession = cloneSession(session);
    let wordIndex = 0;
    while (node.words[wordIndex]?.assignmentName !== undefined) {
      const word = node.words[wordIndex];
      if (word === undefined || word.assignmentName === undefined) break;
      const value = expandAssignmentValue(word, word.assignmentName, assignmentSession);
      assignments.push({ name: word.assignmentName, value });
      assignmentSession.env.set(word.assignmentName, value);
      wordIndex += 1;
    }
    const expanded = await expandWords(
      node.words.slice(wordIndex),
      session,
      runtime.fileSystem,
      runtime.budget,
    );
    let applied;
    try {
      applied = await applyRedirections(
        node.redirections,
        fds,
        session,
        runtime.fileSystem,
        runtime.budget,
        cancelUnreadInput,
      );
    } catch (error) {
      fds = { 0: initialFds[0], 1: initialFds[1], 2: fallbackStderr };
      throw error;
    }
    fds = applied.fds;
    redirected = applied.redirected;
    shouldCancelInput ||= applied.inputRedirected;
    if (expanded.length === 0) {
      for (const value of assignments) session.env.set(value.name, value.value);
      await closeDescriptors(fds);
      return 0;
    }
    const name = expanded.shift() ?? "";
    if (
      runtime.policy.allowedCommands !== undefined
      && !runtime.policy.allowedCommands.includes(name)
    ) throw new VfsError("EACCES", `command is not allowed: ${name}`);
    const command = runtime.commands.get(name);
    if (command === undefined) {
      await fds[2].write(new TextEncoder().encode(`${name}: command not found\n`));
      await closeDescriptors(fds);
      return 127;
    }
    const previous = new Map<string, string | undefined>();
    for (const value of assignments) {
      previous.set(value.name, session.env.get(value.name));
      session.env.set(value.name, value.value);
    }
    let exitCode: number;
    try {
      exitCode = (await command.run(
        {
          fileSystem: runtime.fileSystem,
          session,
          signal: runtime.signal,
          budget: runtime.budget,
          policy: runtime.policy,
        },
        expanded,
        fds,
      ).completed).exitCode;
      if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
        throw new RangeError(`command ${name} returned an invalid exit status: ${exitCode}`);
      }
    } finally {
      const exported = name === "export" ? new Set(expanded.map((value) => value.split("=", 1)[0])) : new Set<string>();
      for (const [variable, oldValue] of previous) {
        if (exported.has(variable)) continue;
        if (oldValue === undefined) session.env.delete(variable);
        else session.env.set(variable, oldValue);
      }
    }
    await closeDescriptors(fds);
    return exitCode;
  } catch (error) {
    if (isDownstreamClosedError(error)) {
      await Promise.allSettled([fds[1].close(), fds[2].close()]);
      return 0;
    }
    if (!isVfsError(error)) {
      await Promise.allSettled([fds[1].abort(error), fds[2].abort(error)]);
      throw error;
    }
    const fatal = isVfsError(error)
      && (error.code === "E2BIG" || error.code === "EFBIG"
        || error.code === "ETIMEDOUT" || error.code === "ECANCELED");
    if (fatal) {
      await abortRedirectedDescriptors(fds, redirected, error);
      throw error;
    }
    semanticFailure = true;
    const message = `${error.path === undefined ? "" : `${error.path}: `}${error.message}`;
    try {
      await fallbackStderr.write(new TextEncoder().encode(`${message}\n`));
    } finally {
      await Promise.allSettled([fds[1].close(), fds[2].close()]);
    }
    return isVfsError(error) ? statusFor(error) : 1;
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
    node: SimpleCommandNode;
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
    runSimpleCommand(stage.node, stage.session, stage.fds, runtime, index > 0)));
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
    if (session.exitRequested) break;
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
    const scriptBytes = new TextEncoder().encode(options.script).byteLength;
    let parsed: ScriptNode | undefined;
    let parseError: VfsError | undefined;
    if (scriptBytes > this.limits.maxScriptBytes) {
      parseError = new VfsError("E2BIG", "shell source exceeds the script byte limit");
    } else {
      try {
        parsed = parseShellScript(options.script, this.limits.maxAstNodes);
      } catch (error) {
        if (!isVfsError(error)) throw error;
        parseError = error;
      }
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
        });
        await closeDescriptors(rootFds);
        return { exitCode };
      } catch (error) {
        if (!isVfsError(error)) {
          await Promise.allSettled([rootFds[1].abort(error), rootFds[2].abort(error)]);
          throw error;
        }
        const message = error.message;
        if (!controller.signal.aborted || error.code === "ETIMEDOUT") {
          try {
            await rootFds[2].write(new TextEncoder().encode(`${message}\n`));
          } catch {
            // The caller may have cancelled stderr too.
          }
        }
        await Promise.allSettled([rootFds[1].close(), rootFds[2].close()]);
        return { exitCode: isVfsError(error) && error.code === "EINVAL" ? 2 : 1 };
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

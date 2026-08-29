import { isVfsError, VfsError, type VfsErrorCode } from "../core/errors.js";
import { encodeUtf8 } from "../core/unicode.js";
import { ExecutionBudget } from "./budget.js";
import type { AppletRegistry } from "./commands/applet.js";
import { type ShellContentReader, scopedContentReader } from "./content.js";
import { emitShellEvent, type ShellEventSink } from "./events.js";
import type { ShellIdentityResolver } from "./identity.js";
import { shellInput } from "./input.js";
import type { ShellNetwork } from "./network.js";
import type { ScriptNode } from "./parser.js";
import { createBytePipe } from "./pipe.js";
import { runCommandNode, runScript } from "./shell-evaluate.js";
import {
  closeDescriptors,
  emptyInput,
  formatError,
  type ParserBudget,
  parseScriptUnit,
  statusFor,
} from "./shell-runtime.js";
import type {
  ExecuteStreamOptions,
  ShellExecution,
  ShellFileDescriptors,
  ShellFileSystem,
  ShellLimits,
  ShellPolicy,
  ShellSession,
} from "./types.js";

export interface ShellExecutionServices {
  readonly commands: AppletRegistry;
  readonly pathLookup: boolean;
  readonly now: () => number;
  readonly fileSystem: (budget: ExecutionBudget, session: ShellSession) => ShellFileSystem;
  readonly content: ShellContentReader | undefined;
  readonly network: ShellNetwork | undefined;
  readonly identityResolver: ShellIdentityResolver | undefined;
  readonly limits: ShellLimits;
  readonly policy: ShellPolicy;
  readonly onEvent: ShellEventSink | undefined;
}

interface ParsedUnit {
  readonly script: ScriptNode | undefined;
  readonly error: VfsError | undefined;
}

interface ExecutionOutcomeState {
  failureCode?: VfsErrorCode;
}

function parseInitialUnit(
  source: string,
  services: ShellExecutionServices,
  parserBudget: ParserBudget,
  budget: ExecutionBudget,
): ParsedUnit {
  try {
    return {
      script: parseScriptUnit(source, services.limits, parserBudget, budget),
      error: undefined,
    };
  } catch (error) {
    if (!isVfsError(error)) throw error;
    return { script: undefined, error };
  }
}

function cancellationError(reason: unknown): VfsError {
  return isVfsError(reason) ? reason : new VfsError("ECANCELED", "execution was cancelled");
}

function attachExternalAbort(
  signal: AbortSignal | undefined,
  controller: AbortController,
): (() => void) | undefined {
  if (signal === undefined) return undefined;
  const abort = () => controller.abort(cancellationError(signal.reason));
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return abort;
}

function createOutputPipe(
  name: "stdout" | "stderr",
  maximumBytes: number,
  controller: AbortController,
  budget: ExecutionBudget,
  services: ShellExecutionServices,
) {
  return createBytePipe({
    maximumBytes,
    signal: controller.signal,
    name,
    account: (bytes) => budget.io(bytes),
    idleTimeoutMs: services.limits.outputIdleTimeoutMs,
    onIdle: () => {
      emitShellEvent(services.onEvent, {
        type: "shell.limit",
        limit: "outputIdleTimeoutMs",
        used: services.limits.outputIdleTimeoutMs,
        max: services.limits.outputIdleTimeoutMs,
      });
      controller.abort(new VfsError("ETIMEDOUT", `${name} consumer did not relieve backpressure`));
    },
    onConsumerCancel: (reason) => controller.abort(cancellationError(reason)),
  });
}

async function runParsedUnit(
  parsed: ScriptNode,
  session: ShellSession,
  fds: ShellFileDescriptors,
  scoped: ShellFileSystem,
  content: ShellContentReader | undefined,
  identities: { resolver: ShellIdentityResolver; signal: AbortSignal } | undefined,
  controller: AbortController,
  parserBudget: ParserBudget,
  budget: ExecutionBudget,
  services: ShellExecutionServices,
): Promise<{ exitCode: number }> {
  const result = await runScript(parsed, session, fds, {
    commands: services.commands,
    pathLookup: services.pathLookup,
    now: services.now,
    fileSystem: scoped,
    budget,
    policy: services.policy,
    content,
    network: services.network,
    identities,
    signal: controller.signal,
    limits: services.limits,
    parserBudget,
    onEvent: services.onEvent,
    runScript,
    runCommandNode,
  });
  await closeDescriptors(fds);
  return { exitCode: result.status };
}

async function reportParseError(
  error: VfsError,
  session: ShellSession,
  fds: ShellFileDescriptors,
  outcome: ExecutionOutcomeState,
): Promise<{ exitCode: number }> {
  await fds[2].write(encodeUtf8(`${error.message}\n`));
  await closeDescriptors(fds);
  const exitCode = error.code === "EINVAL" ? 2 : 1;
  session.lastExitCode = exitCode;
  outcome.failureCode = error.code;
  return { exitCode };
}

async function handleExecutionError(
  error: unknown,
  session: ShellSession,
  fds: ShellFileDescriptors,
  controller: AbortController,
  outcome: ExecutionOutcomeState,
): Promise<{ exitCode: number }> {
  if (!isVfsError(error)) {
    await Promise.allSettled([fds[1].abort(error), fds[2].abort(error)]);
    throw error;
  }
  const exitCode = statusFor(error);
  session.lastExitCode = exitCode;
  outcome.failureCode = error.code;
  if (!controller.signal.aborted || error.code === "ETIMEDOUT") {
    try {
      await fds[2].write(encodeUtf8(`${formatError(error)}\n`));
    } catch {
      // The caller may have cancelled stderr too.
    }
  }
  await Promise.allSettled([fds[1].close(), fds[2].close()]);
  return { exitCode };
}

async function completeExecution(
  parsed: ParsedUnit,
  session: ShellSession,
  fds: ShellFileDescriptors,
  scoped: ShellFileSystem,
  content: ShellContentReader | undefined,
  identities: { resolver: ShellIdentityResolver; signal: AbortSignal } | undefined,
  controller: AbortController,
  parserBudget: ParserBudget,
  budget: ExecutionBudget,
  services: ShellExecutionServices,
  outcome: ExecutionOutcomeState,
  timeout: ReturnType<typeof setTimeout>,
  externalAbort: (() => void) | undefined,
  externalSignal: AbortSignal | undefined,
): Promise<{ exitCode: number }> {
  try {
    if (parsed.error !== undefined) {
      return await reportParseError(parsed.error, session, fds, outcome);
    }
    if (parsed.script === undefined) throw new VfsError("EIO", "parser produced no script");
    return await runParsedUnit(
      parsed.script,
      session,
      fds,
      scoped,
      content,
      identities,
      controller,
      parserBudget,
      budget,
      services,
    );
  } catch (error) {
    return await handleExecutionError(error, session, fds, controller, outcome);
  } finally {
    const reason =
      controller.signal.reason ?? new VfsError("EPIPE", "shell execution stopped reading input");
    await fds[0].cancel(reason).catch(() => undefined);
    clearTimeout(timeout);
    if (externalAbort !== undefined) externalSignal?.removeEventListener("abort", externalAbort);
  }
}

function observeExecution(
  completed: Promise<{ exitCode: number }>,
  budget: ExecutionBudget,
  outcome: ExecutionOutcomeState,
  services: ShellExecutionServices,
): Promise<{ exitCode: number }> {
  return completed.then(
    (result) => {
      emitShellEvent(services.onEvent, {
        type: "shell.execution",
        exitCode: result.exitCode,
        durationMs: budget.elapsedMs(),
        ...(outcome.failureCode === undefined ? {} : { failureCode: outcome.failureCode }),
      });
      return result;
    },
    (error: unknown) => {
      emitShellEvent(services.onEvent, {
        type: "shell.execution",
        exitCode: 1,
        durationMs: budget.elapsedMs(),
        ...(isVfsError(error) ? { failureCode: error.code } : {}),
      });
      throw error;
    },
  );
}

export function executeShellSessionStream(
  options: ExecuteStreamOptions,
  session: ShellSession,
  services: ShellExecutionServices,
): ShellExecution {
  const parserBudget: ParserBudget = { sourceBytes: 0, astNodes: 0 };
  const budget = new ExecutionBudget(services.limits, services.now, services.onEvent);
  const parsed = parseInitialUnit(options.script, services, parserBudget, budget);
  const controller = new AbortController();
  const externalAbort = attachExternalAbort(options.signal, controller);
  const scoped = services.fileSystem(budget, session);
  const identities =
    services.identityResolver === undefined
      ? undefined
      : { resolver: services.identityResolver, signal: controller.signal };
  const content =
    services.content === undefined
      ? undefined
      : scopedContentReader(services.content, (path) => scoped.assertReadable(path));
  const stdout = createOutputPipe(
    "stdout",
    services.limits.maxStdoutBytes,
    controller,
    budget,
    services,
  );
  const stderr = createOutputPipe(
    "stderr",
    services.limits.maxStderrBytes,
    controller,
    budget,
    services,
  );
  const timeout = setTimeout(() => {
    controller.abort(new VfsError("ETIMEDOUT", "shell execution deadline exceeded"));
  }, budget.remainingDeadlineMs());
  const fds: ShellFileDescriptors = {
    0: shellInput(options.stdin ?? emptyInput()),
    1: stdout.sink,
    2: stderr.sink,
  };
  const outcome: ExecutionOutcomeState = {};
  const completed = completeExecution(
    parsed,
    session,
    fds,
    scoped,
    content,
    identities,
    controller,
    parserBudget,
    budget,
    services,
    outcome,
    timeout,
    externalAbort,
    options.signal,
  );
  return {
    stdout: stdout.readable,
    stderr: stderr.readable,
    completed: observeExecution(completed, budget, outcome, services),
    cancel(reason) {
      controller.abort(cancellationError(reason));
    },
  };
}

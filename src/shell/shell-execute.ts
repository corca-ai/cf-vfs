import { VfsError } from "../core/errors.js";
import { encodeUtf8 } from "../core/unicode.js";
import { optindGeneration } from "./environment.js";
import { ShellRefusalError } from "./errors.js";
import { emitShellEvent } from "./events.js";
import type { FunctionDefinitionNode } from "./parser.js";
import { SHELL_PROFILE_COMMAND } from "./script.js";
import { cloneShellSession, prepareShellSessionUnit } from "./session.js";
import {
  describeCommands,
  type PreparedSimpleCommand,
  probeShellOperand,
  resolveApplet,
  resolveExecutableScript,
  resolveShellCommand,
} from "./shell-resolve.js";
import {
  ACTIVE_EVALUATION_CONTEXT,
  type EvaluationContext,
  parseScriptUnit,
  type Runtime,
  runIsolatedShellScope,
  SUPPRESSED_EVALUATION_CONTEXT,
} from "./shell-runtime.js";
import type {
  ShellCommand,
  ShellCommandContext,
  ShellFileDescriptors,
  ShellLocalGetoptsFrame,
  ShellSession,
} from "./types.js";

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

function restoreLocals(
  session: ShellSession,
  frame: ReadonlyMap<string, string | undefined>,
): void {
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
    let status = (
      await runtime.runCommandNode(
        definition.body,
        session,
        { 0: fds[0], 1: fds[1].clone(), 2: fds[2].clone() },
        runtime,
        false,
        context,
      )
    ).status;
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
      session.getopts =
        getoptsFrame.state === undefined
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
  const parsed = parseScriptUnit(
    source,
    runtime.limits,
    runtime.parserBudget,
    runtime.budget,
    path,
  );
  const previousArgs = session.args;
  if (args.length > 0) session.args = [...args];
  session.sourceDepth += 1;
  try {
    let status = (await runtime.runScript(parsed, session, fds, runtime, context)).status;
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

/**
 * Runs a bounded source unit in an isolated child scope.
 *
 * The child clones the caller's session, so it inherits the environment,
 * working directory, and shell options while its own variables, functions,
 * working directory, and `exit` stay inside it. Depth is counted separately
 * from `source`, so a script that sources a file that runs a script is still
 * bounded, and every other budget remains the caller's.
 */
async function runScriptUnit(
  source: string,
  name: string,
  args: readonly string[],
  session: ShellSession,
  fds: ShellFileDescriptors,
  runtime: Runtime,
): Promise<number> {
  if (session.scriptDepth >= runtime.limits.maxScriptDepth) {
    throw new VfsError("E2BIG", "shell script nesting limit exceeded", name);
  }
  // Parse the complete unit before it can mutate anything.
  const parsed = parseScriptUnit(
    source,
    runtime.limits,
    runtime.parserBudget,
    runtime.budget,
    name,
  );
  const child = cloneShellSession(session);
  prepareShellSessionUnit(child);
  child.scriptDepth = session.scriptDepth + 1;
  child.args = [...args];
  // `$0` is the spelling the caller used, which is what Bash hands a script.
  child.env.set("0", name);
  const result = await runIsolatedShellScope(
    async () => await runtime.runScript(parsed, child, fds, runtime, ACTIVE_EVALUATION_CONTEXT),
    fds[2],
  );
  // `exit` ends the script, not the caller: a submitted unit and an interactive
  // session both survive a script that exits.
  return child.exitRequested ? child.requestedExitCode : result.status;
}

interface CommandSelection {
  readonly name: string;
  readonly argv: readonly string[];
  readonly canonicalName: string;
  readonly definition: FunctionDefinitionNode | undefined;
  readonly command: ShellCommand | undefined;
}

interface CommandOutcome {
  readonly exitCode: number;
  readonly eventName: string;
  readonly preserveAssignments: boolean;
}

function applyAssignments(
  assignments: PreparedSimpleCommand["assignments"],
  session: ShellSession,
): ReadonlyMap<string, string | undefined> {
  const previous = new Map<string, string | undefined>();
  for (const value of assignments) {
    previous.set(value.name, session.env.get(value.name));
    session.env.set(value.name, value.value);
  }
  return previous;
}

function selectCommand(
  prepared: PreparedSimpleCommand,
  session: ShellSession,
  runtime: Runtime,
): CommandSelection {
  const [name = "", ...argv] = prepared.argv;
  const definition = prepared.bypassFunctions === true ? undefined : session.functions.get(name);
  const command =
    definition === undefined ? resolveApplet(name, session, runtime)?.command : undefined;
  const canonicalName = command?.name ?? name;
  authorizeCommand(definition, command, canonicalName, runtime);
  return { name, argv, canonicalName, definition, command };
}

function authorizeCommand(
  definition: FunctionDefinitionNode | undefined,
  command: ShellCommand | undefined,
  canonicalName: string,
  runtime: Runtime,
): void {
  const allowed = runtime.policy.allowedCommands;
  if (definition !== undefined || allowed === undefined) return;
  const permitted =
    command === undefined
      ? allowed.includes(SHELL_PROFILE_COMMAND)
      : allowed.includes(canonicalName);
  if (!permitted) throw new ShellRefusalError(`command is not allowed: ${canonicalName}`);
}

async function executeSelection(
  selected: CommandSelection,
  session: ShellSession,
  fds: ShellFileDescriptors,
  runtime: Runtime,
  context: EvaluationContext,
): Promise<CommandOutcome> {
  if (selected.definition !== undefined) {
    const exitCode = await runFunction(
      selected.definition,
      selected.argv,
      session,
      fds,
      runtime,
      context,
    );
    return { exitCode, eventName: selected.canonicalName, preserveAssignments: false };
  }
  if (selected.command !== undefined) {
    const exitCode = await runApplet(
      selected.command,
      selected.argv,
      session,
      fds,
      runtime,
      context,
    );
    return { exitCode, eventName: selected.canonicalName, preserveAssignments: true };
  }
  return await runExternalScript(selected.name, selected.argv, session, fds, runtime);
}

async function runExternalScript(
  name: string,
  argv: readonly string[],
  session: ShellSession,
  fds: ShellFileDescriptors,
  runtime: Runtime,
): Promise<CommandOutcome> {
  const script = await resolveExecutableScript(name, session, runtime);
  if (script === undefined) {
    await fds[2].write(encodeUtf8(`${name}: command not found\n`));
    return { exitCode: 127, eventName: name, preserveAssignments: false };
  }
  runtime.budget.command();
  try {
    const exitCode = await runScriptUnit(script.source, name, argv, session, fds, runtime);
    return { exitCode, eventName: script.path, preserveAssignments: false };
  } finally {
    script.release();
  }
}

function commandContext(
  session: ShellSession,
  runtime: Runtime,
  context: EvaluationContext,
): ShellCommandContext {
  return {
    fileSystem: runtime.fileSystem,
    ...(runtime.identities === undefined ? {} : { identities: runtime.identities }),
    session,
    signal: runtime.signal,
    budget: runtime.budget,
    policy: runtime.policy,
    ...(runtime.content === undefined ? {} : { content: runtime.content }),
    ...(runtime.network === undefined || runtime.policy.network !== "allow"
      ? {}
      : { network: runtime.network }),
    executeSource: async (source, path, args, fds) =>
      await runSourcedUnit(source, path, args, session, fds, runtime, context),
    executeCommand: async (argv, fds, options) => {
      runtime.budget.command();
      return await executeSimpleCommand(
        {
          assignments: [],
          argv: [...argv],
          ...(options?.bypassFunctions === true ? { bypassFunctions: true } : {}),
        },
        session,
        fds,
        runtime,
        SUPPRESSED_EVALUATION_CONTEXT,
      );
    },
    resolveCommand: async (name) => await resolveShellCommand(name, session, runtime),
    listCommands: () => describeCommands(runtime),
    now: () => runtime.now(),
    executeScript: async (source, name, args, fds) =>
      await runScriptUnit(source, name, args, session, fds, runtime),
    executeScriptFile: async (path, args, fds, invokedAs) =>
      await executeScriptFile(path, args, fds, invokedAs, session, runtime),
  };
}

async function executeScriptFile(
  path: string,
  args: readonly string[],
  fds: ShellFileDescriptors,
  invokedAs: string | undefined,
  session: ShellSession,
  runtime: Runtime,
): Promise<number | undefined> {
  const probe = await probeShellOperand(path, runtime);
  if (probe.kind === "absent") return undefined;
  if (probe.kind !== "loaded") throw probe.error;
  try {
    return await runScriptUnit(probe.source, invokedAs ?? path, args, session, fds, runtime);
  } finally {
    probe.release();
  }
}

async function runApplet(
  command: ShellCommand,
  argv: readonly string[],
  session: ShellSession,
  fds: ShellFileDescriptors,
  runtime: Runtime,
  context: EvaluationContext,
): Promise<number> {
  const exitCode = (
    await command.run(commandContext(session, runtime, context), argv, fds).completed
  ).exitCode;
  if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    throw new RangeError(`command ${command.name} returned an invalid exit status: ${exitCode}`);
  }
  return exitCode;
}

export async function executeSimpleCommand(
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
  const previous = applyAssignments(prepared.assignments, session);
  const assignmentArgs = prepared.argv.slice(1);
  let preserveAssignments = false;
  try {
    const selected = selectCommand(prepared, session, runtime);
    const outcome = await executeSelection(selected, session, fds, runtime, context);
    preserveAssignments = outcome.preserveAssignments && selected.canonicalName === "export";
    emitShellEvent(runtime.onEvent, {
      type: "shell.command",
      name: outcome.eventName,
      exitCode: outcome.exitCode,
    });
    return outcome.exitCode;
  } finally {
    const preserved = preserveAssignments
      ? new Set(assignmentArgs.map((value) => value.split("=", 1)[0] ?? ""))
      : new Set<string>();
    restoreVariables(session, previous, preserved);
  }
}

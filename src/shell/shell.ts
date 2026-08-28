import {
  compareDecimalIntegers,
  type NormalizedDecimalInteger,
  normalizeDecimalInteger,
} from "../core/decimal-integer.js";
import { isVfsError, VfsError, type VfsErrorCode } from "../core/errors.js";
import { compareUtf8, normalizePath, normalizePathPreservingTrailingSlash } from "../core/path.js";
import { encodeUtf8, utf8ByteLength } from "../core/unicode.js";
import { supportsPosixCredentials } from "../vfs/capabilities.js";
import { bodyToStream, readAllBytes } from "../vfs/streams.js";
import type { VfsStat, VirtualFileSystem } from "../vfs/types.js";
import { shellModeAllows } from "./access.js";
import { evaluateArithmetic } from "./arithmetic.js";
import { ExecutionBudget, resolveShellLimits } from "./budget.js";
import {
  APPLET_DIRECTORIES,
  type AppletRegistry,
  createAppletRegistry,
  type ShellApplet,
  splitSearchPath,
} from "./commands/applet.js";
import { isCharacterDevice, isRegularFile } from "./commands/format.js";
import { type ShellContentReader, scopedContentReader } from "./content.js";
import { ReservedPathFileSystem } from "./devices.js";
import { optindGeneration } from "./environment.js";
import { ShellNounsetError, ShellRefusalError } from "./errors.js";
import { emitShellEvent, type ShellEventSink } from "./events.js";
import {
  type ExpansionRuntime,
  expandAssignmentValue,
  expandCasePattern,
  expandScalarWord,
  expandWords,
  isShellParameterSet,
  matchesCasePattern,
} from "./expand.js";
import type { ShellIdentityResolver, ShellIdentitySource } from "./identity.js";
import { shellInput } from "./input.js";
import type { ShellNetwork } from "./network.js";
import {
  type AndOrNode,
  type CommandNode,
  type CompoundCommandNode,
  type ConditionalExpression,
  type ConditionalUnaryOperator,
  type FunctionDefinitionNode,
  type PipelineNode,
  parseShellScript,
  type ScriptNode,
  type SimpleCommandNode,
} from "./parser.js";
import { createBytePipe, isDownstreamClosedError } from "./pipe.js";
import { ScopedFileSystem } from "./policy.js";
import { type AppliedRedirections, applyRedirections } from "./redirection.js";
import {
  isExecutableMode,
  readShebangLine,
  SHELL_PROFILE_COMMAND,
  selectsShellProfile,
} from "./script.js";
import { cloneShellSession, createShellSession, prepareShellSessionUnit } from "./session.js";
import type {
  ExecuteBytesResult,
  ExecuteStreamOptions,
  ExecuteTextOptions,
  ExecuteTextResult,
  ShellBudget,
  ShellCommand,
  ShellCommandDescription,
  ShellCommandResolution,
  ShellExecution,
  ShellFileDescriptors,
  ShellFileSystem,
  ShellLimits,
  ShellLocalGetoptsFrame,
  ShellOptions,
  ShellPolicy,
  ShellSession,
  ShellSink,
} from "./types.js";

function emptyInput(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

function statusFor(error: VfsError): number {
  return error instanceof ShellNounsetError
    ? 1
    : error.code === "EINVAL"
      ? 2
      : error instanceof ShellRefusalError || error.code === "ENOEXEC"
        ? 126
        : 1;
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
    await stderr.write(encodeUtf8(`${formatError(error)}\n`));
    return evaluationResult(statusFor(error));
  }
}

async function closeDescriptors(fds: ShellFileDescriptors): Promise<void> {
  const results = await Promise.allSettled([fds[1].close(), fds[2].close()]);
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
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
  commands: AppletRegistry;
  pathLookup: boolean;
  now: () => number;
  fileSystem: ShellFileSystem;
  content: ShellContentReader | undefined;
  network: ShellNetwork | undefined;
  identities: ShellIdentitySource | undefined;
  budget: ShellBudget;
  policy: ShellPolicy;
  signal: AbortSignal;
  limits: ShellLimits;
  parserBudget: ParserBudget;
  onEvent: ShellEventSink | undefined;
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

function requestErrexit(status: number, session: ShellSession, context: EvaluationContext): void {
  if (
    status !== 0 &&
    session.errexit === true &&
    !context.errexitSuppressed &&
    !session.exitRequested &&
    session.flow.type === "none"
  ) {
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
  const sourceBytes = utf8ByteLength(source);
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
      (count) => {
        budget.astNodes += count;
      },
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
      const child = cloneShellSession(session);
      child.errexit = false;
      const childFds: ShellFileDescriptors = {
        0: fds[0],
        1: output.sink,
        2: fds[2].clone(),
      };
      const completed = (async () => {
        try {
          return await runIsolatedShellScope(
            async () =>
              await runScript(script, child, childFds, runtime, ACTIVE_EVALUATION_CONTEXT),
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
        if (value.includes("\0"))
          throw new VfsError("EINVAL", "command substitution produced a NUL byte");
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
  /** Set by `command NAME`, which runs an applet in spite of a function. */
  bypassFunctions?: boolean;
}

interface ResolvedShellCommand {
  readonly command: ShellCommand;
  readonly kind: "builtin" | "program";
  readonly path: string | undefined;
}

/**
 * Resolves a command name to an applet.
 *
 * The `PATH` walk lives here rather than in the registry because only the
 * shell can order a search across components, and only the shell will be able
 * to consult the namespace for an executable file. The registry answers about
 * one name or one component at a time.
 */
function resolveApplet(
  name: string,
  session: ShellSession,
  runtime: Runtime,
): ResolvedShellCommand | undefined {
  const registry = runtime.commands;
  const viaPath = registry.findPath(name);
  if (viaPath !== undefined) {
    // An absolute applet path bypasses PATH, exactly as in Linux.
    return { command: viaPath.command, kind: "program", path: name };
  }
  const entry = registry.find(name);
  if (entry === undefined) return undefined;
  const searchPath = runtime.pathLookup ? session.env.get("PATH") : undefined;
  const hasProgramForm = entry.kind !== "session-builtin";
  let found: string | undefined;
  if (searchPath !== undefined && hasProgramForm) {
    // Left to right, first match wins, so a duplicated component is harmless
    // and the reported path is the one that would run. Components are
    // normalized first, so `/bin/` and `//bin` are the applet directory they
    // name rather than somewhere a stored file could answer instead.
    for (const component of splitSearchPath(searchPath)) {
      const directory = normalizePath(component === "" ? "/" : component);
      if (registry.isAppletDirectory(directory)) {
        found = `${directory}/${name}`;
        break;
      }
    }
  }
  // A built-in resolves whatever PATH says, and still reports the applet path
  // it has so `which echo` can find one. A program needs the search to hit.
  if (entry.kind !== "program") {
    return { command: entry.command, kind: "builtin", path: found };
  }
  if (searchPath === undefined) return { command: entry.command, kind: "program", path: undefined };
  return found === undefined ? undefined : { command: entry.command, kind: "program", path: found };
}

/**
 * Candidate paths an executable VFS file could satisfy `name` from.
 *
 * A name containing a separator is a pathname and never searched, exactly as in
 * Bash. A bare name is searched only under the opt-in `PATH` mode, and only
 * through components that are not virtual applet directories: those already
 * answered, and no stored file may shadow them. Each component is normalized
 * before that comparison.
 */
function executableCandidates(name: string, session: ShellSession, runtime: Runtime): string[] {
  if (name.includes("/")) return [normalizePath(name, session.cwd)];
  if (!runtime.pathLookup) return [];
  const searchPath = session.env.get("PATH");
  if (searchPath === undefined) return [];
  const candidates: string[] = [];
  for (const component of splitSearchPath(searchPath)) {
    // An empty component means the working directory in POSIX. Normalizing
    // before the applet-directory check stops `/bin/`, `//bin`, and `/bin/.`
    // from smuggling a stored file into an applet directory.
    const directory = component === "" ? session.cwd : normalizePath(component);
    if (runtime.commands.isAppletDirectory(directory)) continue;
    candidates.push(normalizePath(name, directory));
  }
  return candidates;
}

/**
 * The outcome of probing one candidate path.
 *
 * A search needs all three apart: `absent` and `denied` contribute nothing and
 * the search continues, while `unusable` is a real refusal worth reporting when
 * nothing else runs.
 */
type ScriptProbe =
  | { readonly kind: "loaded"; readonly source: string; readonly release: () => void }
  | { readonly kind: "absent" }
  | { readonly kind: "denied"; readonly error: VfsError }
  | { readonly kind: "unusable"; readonly error: VfsError };

function unusable(code: "ENOEXEC" | "EACCES", message: string, path: string): ScriptProbe {
  return {
    kind: "unusable",
    error:
      code === "EACCES" ? new ShellRefusalError(message, path) : new VfsError(code, message, path),
  };
}

/** Stats a candidate, mapping "nothing there" and "not readable" to a probe. */
function classifyCandidate(
  path: string,
  runtime: Runtime,
): { stat: VfsStat } | { probe: ScriptProbe } {
  try {
    return { stat: runtime.fileSystem.stat(path) };
  } catch (error) {
    if (!isVfsError(error)) throw error;
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { probe: { kind: "absent" } };
    // A path outside the readable roots supplies nothing to a search, and is
    // worth reporting when it was named explicitly.
    if (error.code === "EACCES") {
      return {
        probe: {
          kind: "denied",
          error:
            error instanceof ShellRefusalError
              ? error
              : new ShellRefusalError(error.message, error.path),
        },
      };
    }
    throw error;
  }
}

/** Probes one path for an executable VFS script. */
async function probeExecutableScript(
  path: string,
  session: ShellSession,
  runtime: Runtime,
): Promise<ScriptProbe> {
  const classified = classifyCandidate(path, runtime);
  if ("probe" in classified) return classified.probe;
  const stat = classified.stat;
  if (stat.kind !== "file") return unusable("ENOEXEC", "is not a regular file", path);
  if (
    session.credentials === undefined
      ? !isExecutableMode(stat.mode)
      : !shellModeAllows(stat, session.credentials, 1)
  )
    return unusable("EACCES", "is not executable", path);
  return await loadScriptSource(path, stat, runtime);
}

/**
 * Probes one path for a script `sh FILE` may run.
 *
 * Identical to an executable file except that the mode bit is not required:
 * naming the interpreter explicitly is the authorization.
 */
async function probeShellOperand(path: string, runtime: Runtime): Promise<ScriptProbe> {
  const classified = classifyCandidate(path, runtime);
  return "probe" in classified
    ? classified.probe
    : await loadScriptSource(path, classified.stat, runtime);
}

/**
 * Reads a bounded inline script and applies the interpreter policy.
 *
 * Shared by an executable file and by `sh FILE`, which differ only in whether
 * the executable mode bit is required, so both report the same statuses.
 */
async function loadScriptSource(
  path: string,
  stat: VfsStat,
  runtime: Runtime,
): Promise<ScriptProbe> {
  if (stat.kind !== "file") return unusable("ENOEXEC", "is not a regular file", path);
  if (stat.contentClass === "opaque") {
    return unusable("ENOEXEC", "opaque content cannot be executed", path);
  }
  const read = runtime.fileSystem.readFile(path);
  let bytes: Uint8Array;
  try {
    bytes = await readAllBytes(read.stream, runtime.limits.maxScriptBytes);
  } catch (error) {
    // The stream limit reports EFBIG, which is otherwise fatal to the whole
    // execution; an oversized script is an ordinary refusal instead.
    if (isVfsError(error) && (error.code === "EFBIG" || error.code === "E2BIG")) {
      return unusable("ENOEXEC", "exceeds the script byte limit", path);
    }
    throw error;
  }
  let line: string | undefined;
  try {
    line = readShebangLine(bytes).line;
  } catch (error) {
    if (!isVfsError(error)) throw error;
    return unusable("ENOEXEC", error.message, path);
  }
  if (line !== undefined && !selectsShellProfile(line)) {
    const spelling = line.trim();
    return unusable(
      "ENOEXEC",
      spelling === "" ? "interpreter line is empty" : `unsupported interpreter: ${spelling}`,
      path,
    );
  }
  const release = runtime.budget.buffered(bytes.byteLength);
  let retained = false;
  try {
    runtime.budget.io(bytes.byteLength);
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return unusable("ENOEXEC", "is not valid UTF-8", path);
    }
    if (source.includes("\0")) return unusable("ENOEXEC", "contains a NUL byte", path);
    retained = true;
    return { kind: "loaded", source, release };
  } finally {
    // A refusal keeps nothing, so it must not keep the lease either.
    if (!retained) release();
  }
}

/**
 * Finds the executable VFS script a name selects, if any.
 *
 * An explicit pathname fails immediately when it exists but cannot run, because
 * there is nothing else to try. A `PATH` search skips such a candidate and
 * keeps looking, exactly as Bash does, and reports the first refusal only when
 * no component supplied anything runnable — so one non-executable entry cannot
 * mask a command a later component provides. A component outside the readable
 * roots supplies nothing at all, so it cannot turn an unknown command into 126.
 */
async function resolveExecutableScript(
  name: string,
  session: ShellSession,
  runtime: Runtime,
): Promise<{ source: string; path: string; release: () => void } | undefined> {
  if (name === "") return undefined;
  const explicit = name.includes("/");
  let refusal: VfsError | undefined;
  for (const candidate of executableCandidates(name, session, runtime)) {
    // A script-controlled PATH decides how many probes happen, so each one
    // charges a step, which also checks the deadline.
    runtime.budget.step();
    const probe = await probeExecutableScript(candidate, session, runtime);
    if (probe.kind === "loaded") {
      return { source: probe.source, release: probe.release, path: candidate };
    }
    if (probe.kind === "absent") continue;
    if (explicit) throw probe.error;
    if (probe.kind === "unusable") refusal ??= probe.error;
  }
  if (refusal !== undefined) throw refusal;
  return undefined;
}

/**
 * Describes every registered applet.
 *
 * An applet without a specification is still listed, so a consumer's own
 * `ShellCommand` appears in help rather than silently missing.
 */
function hasAppletSpec(command: ShellCommand): command is ShellApplet {
  return "spec" in command;
}

function describeCommands(registry: Pick<Runtime, "commands">): readonly ShellCommandDescription[] {
  const described: ShellCommandDescription[] = [];
  for (const name of registry.commands.names()) {
    const entry = registry.commands.find(name);
    if (entry === undefined) continue;
    const spec = hasAppletSpec(entry.command) ? entry.command.spec : undefined;
    described.push({
      name,
      kind: entry.kind,
      usage: spec?.usage ?? "",
      summary: spec?.summary ?? "",
    });
  }
  return described;
}

/**
 * Finds an executable VFS file a name selects, without reading it.
 *
 * Discovery classifies rather than runs, so it stops at the mode bit: a file
 * whose interpreter line is unsupported is still what `type` reports, exactly
 * as in Bash, and no content is read to answer a question about a name.
 */
async function findExecutablePath(
  name: string,
  session: ShellSession,
  runtime: Runtime,
): Promise<string | undefined> {
  if (name === "") return undefined;
  for (const candidate of executableCandidates(name, session, runtime)) {
    runtime.budget.step();
    const classified = classifyCandidate(candidate, runtime);
    if ("probe" in classified) continue;
    const stat = classified.stat;
    if (
      stat.kind === "file" &&
      (session.credentials === undefined
        ? isExecutableMode(stat.mode)
        : shellModeAllows(stat, session.credentials, 1))
    )
      return candidate;
  }
  return undefined;
}

/**
 * Reports how a name would resolve, using exactly the order execution uses:
 * shell function, then the applet resolver, then an executable VFS file, then
 * the command policy.
 *
 * A name the policy denies is reported as unresolved, so discovery can never
 * advertise a command that would immediately fail with 126, and a name that
 * resolves to a file is reported so it can never fail to advertise one that
 * would run.
 */
async function resolveShellCommand(
  name: string,
  session: ShellSession,
  runtime: Runtime,
): Promise<ShellCommandResolution | undefined> {
  if (session.functions.has(name)) return { kind: "function", name };
  const allowed = runtime.policy.allowedCommands;
  const resolved = resolveApplet(name, session, runtime);
  if (resolved !== undefined) {
    if (allowed !== undefined && !allowed.includes(resolved.command.name)) return undefined;
    return { kind: resolved.kind, name: resolved.command.name, path: resolved.path };
  }
  if (allowed !== undefined && !allowed.includes(SHELL_PROFILE_COMMAND)) return undefined;
  const path = await findExecutablePath(name, session, runtime);
  if (path === undefined) return undefined;
  // An explicit pathname reports the spelling that was given, which is what a
  // caller can run; a searched name reports where the search found it.
  return { kind: "program", name, path: name.includes("/") ? name : path };
}

async function prepareSimpleCommand(
  node: SimpleCommandNode,
  session: ShellSession,
  runtime: Runtime,
  expansion: ExpansionRuntime,
): Promise<PreparedSimpleCommand> {
  const assignments: Array<{ name: string; value: string }> = [];
  const assignmentSession = cloneShellSession(session);
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
      await runCommandNode(
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
    async () => await runScript(parsed, child, fds, runtime, ACTIVE_EVALUATION_CONTEXT),
    fds[2],
  );
  // `exit` ends the script, not the caller: a submitted unit and an interactive
  // session both survive a script that exits.
  return child.exitRequested ? child.requestedExitCode : result.status;
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
  // Prefix assignments apply before the name is resolved, so `PATH=/opt cat`
  // searches the assigned PATH exactly as Bash does.
  const previous = new Map<string, string | undefined>();
  for (const value of prepared.assignments) {
    previous.set(value.name, session.env.get(value.name));
    session.env.set(value.name, value.value);
  }
  let canonicalName = name;
  let ranCommandName: string | undefined;
  try {
    const definition = prepared.bypassFunctions === true ? undefined : session.functions.get(name);
    // Resolve before the policy check so an allowlist naming an applet also
    // covers its aliases and virtual `/bin` spelling, and so a denial reports
    // the canonical name rather than the spelling that reached the shell.
    const command =
      definition === undefined ? resolveApplet(name, session, runtime)?.command : undefined;
    canonicalName = command?.name ?? name;
    const allowed = runtime.policy.allowedCommands;
    if (definition === undefined && allowed !== undefined) {
      // An applet is authorized by its canonical name. A name no applet claims
      // may still be an executable file, which one `sh` entry authorizes rather
      // than every script path an application might ever store.
      const permitted =
        command === undefined
          ? allowed.includes(SHELL_PROFILE_COMMAND)
          : allowed.includes(canonicalName);
      if (!permitted) {
        throw new ShellRefusalError(`command is not allowed: ${canonicalName}`);
      }
    }
    let exitCode: number;
    if (definition !== undefined) {
      exitCode = await runFunction(definition, argv, session, fds, runtime, context);
    } else {
      if (command === undefined) {
        // No applet answered. An executable VFS file may still: a pathname
        // names one directly, and under the PATH search a component that is
        // not an applet directory may hold one.
        const script = await resolveExecutableScript(name, session, runtime);
        if (script !== undefined) {
          runtime.budget.command();
          try {
            // `$0` is the spelling that was typed; the resolved path names the
            // file in diagnostics and in the observed event.
            exitCode = await runScriptUnit(script.source, name, argv, session, fds, runtime);
          } finally {
            script.release();
          }
          emitShellEvent(runtime.onEvent, { type: "shell.command", name: script.path, exitCode });
          return exitCode;
        }
        await fds[2].write(encodeUtf8(`${name}: command not found\n`));
        emitShellEvent(runtime.onEvent, { type: "shell.command", name, exitCode: 127 });
        return 127;
      }
      // Only the applet that actually ran may claim the `export` restoration
      // rule below; a denied command, an unknown name, and a shell function
      // named `export` must all leave the prefix assignment undone.
      ranCommandName = canonicalName;
      exitCode = (
        await command.run(
          {
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
            executeSource: async (source, path, sourceArgs, sourceFds) =>
              await runSourcedUnit(source, path, sourceArgs, session, sourceFds, runtime, context),
            executeCommand: async (commandArgv, commandFds, commandOptions) => {
              runtime.budget.command();
              // The invoked status belongs to the invoking utility, not to the
              // enclosing shell, so it never requests errexit on its own.
              return await executeSimpleCommand(
                {
                  assignments: [],
                  argv: [...commandArgv],
                  ...(commandOptions?.bypassFunctions === true ? { bypassFunctions: true } : {}),
                },
                session,
                commandFds,
                runtime,
                SUPPRESSED_EVALUATION_CONTEXT,
              );
            },
            resolveCommand: async (candidate) =>
              await resolveShellCommand(candidate, session, runtime),
            listCommands: () => describeCommands(runtime),
            now: () => runtime.now(),
            executeScript: async (scriptSource, scriptName, scriptArgs, scriptFds) =>
              await runScriptUnit(
                scriptSource,
                scriptName,
                scriptArgs,
                session,
                scriptFds,
                runtime,
              ),
            executeScriptFile: async (scriptPath, scriptArgs, scriptFds, invokedAs) => {
              const probe = await probeShellOperand(scriptPath, runtime);
              if (probe.kind === "absent") return undefined;
              if (probe.kind !== "loaded") throw probe.error;
              try {
                return await runScriptUnit(
                  probe.source,
                  invokedAs ?? scriptPath,
                  scriptArgs,
                  session,
                  scriptFds,
                  runtime,
                );
              } finally {
                probe.release();
              }
            },
          },
          argv,
          fds,
        ).completed
      ).exitCode;
      if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
        throw new RangeError(
          `command ${canonicalName} returned an invalid exit status: ${exitCode}`,
        );
      }
    }
    emitShellEvent(runtime.onEvent, { type: "shell.command", name: canonicalName, exitCode });
    return exitCode;
  } finally {
    const preserved =
      ranCommandName === "export"
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

function normalizeConditionalInteger(value: string, budget: ShellBudget): NormalizedDecimalInteger {
  budget.expansionWork(value.length);
  const normalized = normalizeDecimalInteger(value);
  if (normalized === undefined) {
    throw new VfsError("EINVAL", "[[: integer expression expected");
  }
  return normalized;
}

function compareConditionalIntegers(left: string, right: string, budget: ShellBudget): number {
  return compareDecimalIntegers(
    normalizeConditionalInteger(left, budget),
    normalizeConditionalInteger(right, budget),
  );
}

/**
 * Answers a `[[ ]]` file predicate.
 *
 * The mapping is exhaustive rather than defaulted, so adding an operator to the
 * parser's list without deciding its meaning is a type error instead of
 * silently inheriting `-d`.
 */
function conditionalFileTest(
  operator: ConditionalUnaryOperator,
  stat: VfsStat,
  session: ShellSession,
): boolean {
  switch (operator) {
    case "-e":
      return true;
    case "-L":
    case "-h":
      return stat.kind === "symlink";
    case "-c":
      return isCharacterDevice(stat);
    case "-f":
      // A regular file, which a character device is not — the mode's type
      // field is the only thing that distinguishes them here.
      return stat.kind === "file" && isRegularFile(stat);
    case "-d":
      return stat.kind === "directory";
    case "-s":
      return stat.sizeBytes > 0;
    // Effective mode bits when credentials exist; compatibility fallback
    // otherwise. See the `test` profile.
    case "-r":
      return shellModeAllows(stat, session.credentials, 4);
    case "-w":
      return shellModeAllows(stat, session.credentials, 2);
    case "-x":
      return shellModeAllows(stat, session.credentials, 1);
    default:
      throw new VfsError("EINVAL", `[[: unsupported unary operator ${operator}`);
  }
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
      value =
        (
          await expandScalarWord(
            current.word,
            session,
            runtime.fileSystem,
            runtime.budget,
            expansion,
          )
        ).length > 0;
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
      else if (current.operator === "-v") value = isShellParameterSet(operand, session);
      else if (operand.length === 0) value = false;
      else {
        try {
          const path = normalizePathPreservingTrailingSlash(operand, session.cwd);
          // `-L` and `-h` ask about the link; every other predicate asks about
          // what it points at, which is why a dangling link fails `-e`.
          const asks = current.operator === "-L" || current.operator === "-h";
          const stat = asks ? runtime.fileSystem.lstat(path) : runtime.fileSystem.stat(path);
          value = conditionalFileTest(current.operator, stat, session);
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
      const target = node.subshell ? cloneShellSession(session) : session;
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
        (await evaluateConditional(node.expression, session, runtime, expansion)) ? 0 : 1,
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
    if (isDownstreamClosedError(error)) {
      await Promise.allSettled([fds[1].close(), fds[2].close()]);
      return evaluationResult(0);
    }
    if (!isVfsError(error)) {
      await Promise.allSettled([fds[1].abort(error), fds[2].abort(error)]);
      throw error;
    }
    const fatal =
      error.code === "E2BIG" ||
      error.code === "EFBIG" ||
      error.code === "ETIMEDOUT" ||
      error.code === "ECANCELED";
    if (fatal || error instanceof ShellNounsetError) {
      await abortRedirectedDescriptors(fds, redirected, error);
      throw error;
    }
    semanticFailure = true;
    const message = formatError(error);
    try {
      await semanticStderr.write(encodeUtf8(`${message}\n`));
    } finally {
      await Promise.allSettled([fds[1].close(), fds[2].close()]);
    }
    return evaluationResult(statusFor(error));
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
      session: pipeline.commands.length === 1 ? session : cloneShellSession(session),
      fds: { 0: input, 1: output, 2: outerFds[2].clone() },
      context:
        index === pipeline.commands.length - 1 ? pipelineContext : suppressErrexit(pipelineContext),
    });
    if (nextInput !== undefined) input = nextInput;
  }
  const isolated =
    pipeline.commands.length > 1 ||
    (pipeline.commands[0]?.type === "group" && pipeline.commands[0].subshell);
  const results = await Promise.all(
    stages.map((stage, index) =>
      isolated
        ? runIsolatedShellScope(
            async () =>
              await runCommandNode(
                stage.node,
                stage.session,
                stage.fds,
                runtime,
                index > 0,
                stage.context,
              ),
            outerFds[2],
          )
        : runCommandNode(stage.node, stage.session, stage.fds, runtime, index > 0, stage.context),
    ),
  );
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
  private readonly commands: AppletRegistry;
  #appletListing: readonly string[] | undefined;
  private readonly pathLookup: boolean;
  private readonly fileSystem: ShellOptions["fileSystem"];
  private readonly policy: ShellPolicy;
  private readonly content: ShellContentReader | undefined;
  private readonly network: ShellNetwork | undefined;
  private readonly identityResolver: ShellIdentityResolver | undefined;
  private readonly limits: ShellLimits;
  private readonly now: () => number;
  private readonly onEvent: ShellEventSink | undefined;

  constructor(options: ShellOptions) {
    this.commands = createAppletRegistry(options.commands);
    this.pathLookup = options.commandResolution === "path";
    this.fileSystem = options.fileSystem;
    this.content = options.content;
    this.network = options.network;
    this.identityResolver = options.identityResolver;
    this.policy = Object.freeze({
      ...(options.policy?.readRoots === undefined
        ? {}
        : {
            readRoots: Object.freeze(options.policy.readRoots.map((path) => normalizePath(path))),
          }),
      ...(options.policy?.writeRoots === undefined
        ? {}
        : {
            writeRoots: Object.freeze(options.policy.writeRoots.map((path) => normalizePath(path))),
          }),
      ...(options.policy?.opaqueContent === undefined
        ? {}
        : { opaqueContent: options.policy.opaqueContent }),
      ...(options.policy?.network === undefined ? {} : { network: options.policy.network }),
      ...(options.policy?.allowedCommands === undefined
        ? {}
        : { allowedCommands: Object.freeze([...options.policy.allowedCommands]) }),
      ...(options.policy?.maxMutations === undefined
        ? {}
        : { maxMutations: options.policy.maxMutations }),
    });
    this.limits = Object.freeze(
      resolveShellLimits({
        ...options.limits,
        ...(options.policy?.maxMutations === undefined
          ? {}
          : { maxMutations: options.policy.maxMutations }),
      }),
    );
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent;
  }

  /**
   * Describes every registered applet, in UTF-8 byte order by name.
   *
   * The same list `help` sees. It is public because completion runs before any
   * command exists, in the interactive layer, which has no command context to
   * ask.
   */
  listCommands(): readonly ShellCommandDescription[] {
    return describeCommands({ commands: this.commands });
  }

  /**
   * What a session may be offered, from the same rules that would run it.
   *
   * Built here rather than assembled by a subclass out of fields, because both
   * halves are policy decisions the shell owns. The filesystem is the scoped
   * one every execution uses, so completion cannot list a directory the
   * session could not read — discovery through a different door than
   * execution is how a sandbox leaks. The names are filtered by the command
   * allowlist and include the applet path spellings that actually resolve, so
   * completion never advertises a command that would fail with 126 or 127.
   */
  /**
   * The names this session could actually run, in resolution order.
   *
   * Filtered by the command allowlist and joined with the session's own
   * functions, so nothing offered or listed is a command that would be refused.
   */
  #runnableNames(functions: ReadonlySet<string>): string[] {
    const allowed = this.policy.allowedCommands;
    const names: string[] = [];
    for (const command of this.commands.names()) {
      if (allowed !== undefined && !allowed.includes(command)) continue;
      names.push(command);
    }
    for (const name of functions) if (!names.includes(name)) names.push(name);
    return names.sort();
  }

  /**
   * The filesystem a session sees: the policy's, with the reserved paths in
   * front of it.
   *
   * The applet directories are listable rather than absent, so `which cat`
   * answering `/bin/cat` and `ls /bin` showing it are the same fact. They hold
   * no rows — a row there could be removed while `/bin/cat` kept working —
   * which is why they are reserved here instead of provisioned.
   */
  #reservedView(
    budget: ExecutionBudget,
    fileSystem: VirtualFileSystem = this.fileSystem,
  ): ShellFileSystem {
    this.#appletListing ??= this.#buildAppletListing();
    return new ReservedPathFileSystem(new ScopedFileSystem(fileSystem, this.policy, budget), {
      applets: { directories: APPLET_DIRECTORIES, names: this.#appletListing },
    });
  }

  #sessionFileSystem(session: ShellSession): VirtualFileSystem {
    if (session.credentials === undefined) return this.fileSystem;
    if (!supportsPosixCredentials(this.fileSystem)) {
      throw new VfsError("ENOTSUP", "filesystem does not support POSIX credentials");
    }
    return this.fileSystem.forCredentials(session.credentials, { umask: session.umask });
  }

  /**
   * The applet directory listing, which depends only on the registry and the
   * policy and so is computed once rather than per execution.
   *
   * Session functions are deliberately not an input: a function is not a
   * program, so it has no path form and the filter below would drop it anyway.
   */
  #buildAppletListing(): readonly string[] {
    const directory = APPLET_DIRECTORIES[0] ?? "/bin";
    const allowed = this.policy.allowedCommands;
    const listed: string[] = [];
    for (const name of this.commands.names()) {
      if (allowed !== undefined && !allowed.includes(name)) continue;
      // Only names that resolve as a path belong in the listing, which is what
      // keeps a session-built-in like `cd` from appearing as `/bin/cd` and
      // then failing with 127.
      if (this.commands.findPath(`${directory}/${name}`) === undefined) continue;
      // And only names that survive being written as one. `.` is a real
      // applet, but `/bin/.` normalizes back to `/bin`, so listing it would
      // put the directory inside itself.
      if (name === "." || name === ".." || name.includes("/")) continue;
      listed.push(name);
    }
    return listed.sort();
  }

  protected completionSource(session: ShellSession): {
    fileSystem: ShellFileSystem;
    commands: readonly string[];
    appletDirectories: readonly string[];
  } {
    const budget = new ExecutionBudget(this.limits, this.now, this.onEvent);
    // A shell function is a name this session created, and it resolves before
    // any applet does.
    const names = this.#runnableNames(new Set(session.functions.keys()));
    return {
      fileSystem: this.#reservedView(budget, this.#sessionFileSystem(session)),
      commands: names,
      // An absolute applet path resolves before any PATH search, so these
      // spell a runnable command whether or not PATH lookup is enabled.
      appletDirectories: APPLET_DIRECTORIES,
    };
  }

  executeStream(options: ExecuteStreamOptions): ShellExecution {
    return this.executeSessionStream(options, createShellSession(options));
  }

  protected executeSessionStream(
    options: ExecuteStreamOptions,
    session: ShellSession,
  ): ShellExecution {
    const parserBudget: ParserBudget = { sourceBytes: 0, astNodes: 0 };
    const budget = new ExecutionBudget(this.limits, this.now, this.onEvent);
    let parsed: ScriptNode | undefined;
    let parseError: VfsError | undefined;
    try {
      parsed = parseScriptUnit(options.script, this.limits, parserBudget, budget);
    } catch (error) {
      if (!isVfsError(error)) throw error;
      parseError = error;
    }
    const controller = new AbortController();
    const cancelled = (reason: unknown): VfsError =>
      isVfsError(reason) ? reason : new VfsError("ECANCELED", "execution was cancelled");
    let externalAbort: (() => void) | undefined;
    if (options.signal !== undefined) {
      externalAbort = () => controller.abort(cancelled(options.signal?.reason));
      if (options.signal.aborted) externalAbort();
      else options.signal.addEventListener("abort", externalAbort, { once: true });
    }
    // Devices sit above the policy rather than under it, because they are
    // outside the namespace the roots govern: `/dev/null` discards, and the
    // descriptor paths duplicate streams the caller already handed this
    // execution. None of them can name anything the roots protect, so
    // requiring `/dev` in a session's roots would break `> /dev/null` for
    // every scoped caller while preventing nothing.
    const scoped = this.#reservedView(budget, this.#sessionFileSystem(session));
    const identities =
      this.identityResolver === undefined
        ? undefined
        : { resolver: this.identityResolver, signal: controller.signal };
    // The reader a host supplies is built over the unscoped filesystem, which
    // is where the lease lives; a session's copy carries the session's roots.
    const content =
      this.content === undefined
        ? undefined
        : scopedContentReader(this.content, (path) => {
            scoped.assertReadable(path);
          });
    const stdout = createBytePipe({
      maximumBytes: this.limits.maxStdoutBytes,
      signal: controller.signal,
      name: "stdout",
      account: (bytes) => budget.io(bytes),
      idleTimeoutMs: this.limits.outputIdleTimeoutMs,
      onIdle: () => {
        emitShellEvent(this.onEvent, {
          type: "shell.limit",
          limit: "outputIdleTimeoutMs",
          used: this.limits.outputIdleTimeoutMs,
          max: this.limits.outputIdleTimeoutMs,
        });
        controller.abort(new VfsError("ETIMEDOUT", "stdout consumer did not relieve backpressure"));
      },
      onConsumerCancel: (reason) => controller.abort(cancelled(reason)),
    });
    const stderr = createBytePipe({
      maximumBytes: this.limits.maxStderrBytes,
      signal: controller.signal,
      name: "stderr",
      account: (bytes) => budget.io(bytes),
      idleTimeoutMs: this.limits.outputIdleTimeoutMs,
      onIdle: () => {
        emitShellEvent(this.onEvent, {
          type: "shell.limit",
          limit: "outputIdleTimeoutMs",
          used: this.limits.outputIdleTimeoutMs,
          max: this.limits.outputIdleTimeoutMs,
        });
        controller.abort(new VfsError("ETIMEDOUT", "stderr consumer did not relieve backpressure"));
      },
      onConsumerCancel: (reason) => controller.abort(cancelled(reason)),
    });
    const timeout = setTimeout(() => {
      controller.abort(new VfsError("ETIMEDOUT", "shell execution deadline exceeded"));
    }, budget.remainingDeadlineMs());
    const rootFds: ShellFileDescriptors = {
      0: shellInput(options.stdin ?? emptyInput()),
      1: stdout.sink,
      2: stderr.sink,
    };
    let failureCode: VfsErrorCode | undefined;
    const completed = (async () => {
      try {
        if (parseError !== undefined) {
          await rootFds[2].write(encodeUtf8(`${parseError.message}\n`));
          await closeDescriptors(rootFds);
          const exitCode = parseError.code === "EINVAL" ? 2 : 1;
          session.lastExitCode = exitCode;
          failureCode = parseError.code;
          return { exitCode };
        }
        if (parsed === undefined) throw new VfsError("EIO", "parser produced no script");
        const result = await runScript(parsed, session, rootFds, {
          commands: this.commands,
          pathLookup: this.pathLookup,
          now: this.now,
          fileSystem: scoped,
          budget,
          policy: this.policy,
          content,
          network: this.network,
          identities,
          signal: controller.signal,
          limits: this.limits,
          parserBudget,
          onEvent: this.onEvent,
        });
        await closeDescriptors(rootFds);
        return { exitCode: result.status };
      } catch (error) {
        if (!isVfsError(error)) {
          await Promise.allSettled([rootFds[1].abort(error), rootFds[2].abort(error)]);
          throw error;
        }
        const message = formatError(error);
        const exitCode = statusFor(error);
        session.lastExitCode = exitCode;
        failureCode = error.code;
        if (!controller.signal.aborted || error.code === "ETIMEDOUT") {
          try {
            await rootFds[2].write(encodeUtf8(`${message}\n`));
          } catch {
            // The caller may have cancelled stderr too.
          }
        }
        await Promise.allSettled([rootFds[1].close(), rootFds[2].close()]);
        return { exitCode };
      } finally {
        const inputReason =
          controller.signal.reason ??
          new VfsError("EPIPE", "shell execution stopped reading input");
        await rootFds[0].cancel(inputReason).catch(() => undefined);
        clearTimeout(timeout);
        if (externalAbort !== undefined)
          options.signal?.removeEventListener("abort", externalAbort);
      }
    })();
    const observed = completed.then(
      (result) => {
        emitShellEvent(this.onEvent, {
          type: "shell.execution",
          exitCode: result.exitCode,
          durationMs: budget.elapsedMs(),
          ...(failureCode === undefined ? {} : { failureCode }),
        });
        return result;
      },
      (error: unknown) => {
        emitShellEvent(this.onEvent, {
          type: "shell.execution",
          exitCode: 1,
          durationMs: budget.elapsedMs(),
          ...(isVfsError(error) ? { failureCode: error.code } : {}),
        });
        throw error;
      },
    );
    return {
      stdout: stdout.readable,
      stderr: stderr.readable,
      completed: observed,
      cancel(reason) {
        controller.abort(cancelled(reason));
      },
    };
  }

  async executeText(options: ExecuteTextOptions): Promise<ExecuteTextResult> {
    return this.executeSessionText(options, createShellSession(options));
  }

  protected async executeSessionText(
    options: ExecuteTextOptions,
    session: ShellSession,
  ): Promise<ExecuteTextResult> {
    const result = await this.executeSessionBytes(options, session);
    return {
      exitCode: result.exitCode,
      stdout: new TextDecoder().decode(result.stdoutBytes),
      stderr: new TextDecoder().decode(result.stderrBytes),
    };
  }

  async executeBytes(options: ExecuteTextOptions): Promise<ExecuteBytesResult> {
    return this.executeSessionBytes(options, createShellSession(options));
  }

  protected async executeSessionBytes(
    options: ExecuteTextOptions,
    session: ShellSession,
  ): Promise<ExecuteBytesResult> {
    const { stdin: input, ...streamOptions } = options;
    const stdin =
      typeof input === "string" || input instanceof Uint8Array ? bodyToStream(input) : input;
    const execution = this.executeSessionStream(
      {
        ...streamOptions,
        ...(stdin === undefined ? {} : { stdin }),
      },
      session,
    );
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

import { isVfsError, VfsError } from "../core/errors.js";
import { normalizePath } from "../core/path.js";
import { readAllBytes } from "../vfs/streams.js";
import type { VfsStat } from "../vfs/types.js";
import { shellModeAllows } from "./access.js";
import { type ShellApplet, splitSearchPath } from "./commands/applet.js";
import { ShellRefusalError } from "./errors.js";
import { type ExpansionRuntime, expandAssignmentValue, expandWords } from "./expand.js";
import type { SimpleCommandNode } from "./parser.js";
import {
  isExecutableMode,
  readShebangLine,
  SHELL_PROFILE_COMMAND,
  selectsShellProfile,
} from "./script.js";
import { cloneShellSession } from "./session.js";
import type { Runtime } from "./shell-runtime.js";
import type {
  ShellCommand,
  ShellCommandDescription,
  ShellCommandResolution,
  ShellSession,
} from "./types.js";

export interface PreparedSimpleCommand {
  assignments: Array<{ name: string; value: string }>;
  argv: string[];
  substitutionStatus?: number;
  /** Set by `command NAME`, which runs an applet in spite of a function. */
  bypassFunctions?: boolean;
}

export interface ResolvedShellCommand {
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
export function resolveApplet(
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
  const found = hasProgramForm ? findAppletPath(name, searchPath, runtime) : undefined;
  // A built-in resolves whatever PATH says, and still reports the applet path
  // it has so `which echo` can find one. A program needs the search to hit.
  if (entry.kind !== "program") {
    return { command: entry.command, kind: "builtin", path: found };
  }
  if (searchPath === undefined) return { command: entry.command, kind: "program", path: undefined };
  return found === undefined ? undefined : { command: entry.command, kind: "program", path: found };
}

function findAppletPath(
  name: string,
  searchPath: string | undefined,
  runtime: Runtime,
): string | undefined {
  if (searchPath === undefined) return undefined;
  // Left to right, first match wins. Normalize aliases such as `/bin/` first.
  for (const component of splitSearchPath(searchPath)) {
    const directory = normalizePath(component === "" ? "/" : component);
    if (runtime.commands.isAppletDirectory(directory)) return `${directory}/${name}`;
  }
  return undefined;
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
export async function probeShellOperand(path: string, runtime: Runtime): Promise<ScriptProbe> {
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
  const bytes = await readScriptBytes(path, runtime);
  if (bytes instanceof VfsError) return { kind: "unusable", error: bytes };
  const interpreterError = validateInterpreter(bytes, path);
  if (interpreterError !== undefined) return interpreterError;
  const release = runtime.budget.buffered(bytes.byteLength);
  try {
    runtime.budget.io(bytes.byteLength);
    const source = decodeScript(bytes);
    if (source === undefined) {
      release();
      return unusable("ENOEXEC", "is not valid UTF-8", path);
    }
    if (source.includes("\0")) {
      release();
      return unusable("ENOEXEC", "contains a NUL byte", path);
    }
    return { kind: "loaded", source, release };
  } catch (error) {
    release();
    throw error;
  }
}

async function readScriptBytes(path: string, runtime: Runtime): Promise<Uint8Array | VfsError> {
  try {
    return await readAllBytes(
      runtime.fileSystem.readFile(path).stream,
      runtime.limits.maxScriptBytes,
    );
  } catch (error) {
    // An oversized script is an ordinary refusal, not a fatal execution error.
    if (isVfsError(error) && (error.code === "EFBIG" || error.code === "E2BIG")) {
      return new VfsError("ENOEXEC", "exceeds the script byte limit", path);
    }
    throw error;
  }
}

function validateInterpreter(bytes: Uint8Array, path: string): ScriptProbe | undefined {
  let line: string | undefined;
  try {
    line = readShebangLine(bytes).line;
  } catch (error) {
    if (!isVfsError(error)) throw error;
    return unusable("ENOEXEC", error.message, path);
  }
  if (line === undefined || selectsShellProfile(line)) return undefined;
  const spelling = line.trim();
  return unusable(
    "ENOEXEC",
    spelling === "" ? "interpreter line is empty" : `unsupported interpreter: ${spelling}`,
    path,
  );
}

function decodeScript(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
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
export async function resolveExecutableScript(
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

export function describeCommands(
  registry: Pick<Runtime, "commands">,
): readonly ShellCommandDescription[] {
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
export async function resolveShellCommand(
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

export async function prepareSimpleCommand(
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

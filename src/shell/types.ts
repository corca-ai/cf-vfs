import type { VfsStat, VirtualFileSystem } from "../vfs/types.js";
import type { ShellEventSink } from "./events.js";
import type { FunctionDefinitionNode } from "./parser.js";

export type ShellFileSystem = Pick<
  VirtualFileSystem,
  | "getMutationToken"
  | "stat"
  | "list"
  | "listPage"
  | "find"
  | "findPage"
  | "countSubtree"
  | "readFile"
  | "writeFile"
  | "appendFile"
  | "touch"
  | "setMetadata"
  | "mkdir"
  | "remove"
  | "move"
  | "copy"
> & {
  inspectWriteTarget(path: string): VfsStat | null;
};

export interface ShellSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
  clone(): ShellSink;
}

export interface ShellFileDescriptors {
  0: ReadableStream<Uint8Array>;
  1: ShellSink;
  2: ShellSink;
}

export interface ShellSession {
  cwd: string;
  env: Map<string, string>;
  args: string[];
  lastExitCode: number;
  exitRequested: boolean;
  requestedExitCode: number;
  pipefail: boolean;
  errexit?: boolean;
  nounset?: boolean;
  functions: Map<string, FunctionDefinitionNode>;
  functionDepth: number;
  sourceDepth: number;
  scriptDepth: number;
  loopDepth: number;
  localFrames: Array<Map<string, string | undefined>>;
  localGetoptsFrames: ShellLocalGetoptsFrame[];
  getopts: ShellGetoptsState | undefined;
  flow: ShellFlow;
}

export interface ShellGetoptsState {
  optind: number;
  characterIndex: number;
  optindGeneration: number;
}

export interface ShellLocalGetoptsFrame {
  captured: boolean;
  state: ShellGetoptsState | undefined;
}

export type ShellFlow =
  | { type: "none" }
  | { type: "errexit" }
  | { type: "return"; status: number }
  | { type: "break" | "continue"; levels: number };

export interface ShellPolicy {
  readonly readRoots?: readonly string[];
  readonly writeRoots?: readonly string[];
  /**
   * Canonical applet names a script may run.
   *
   * A name is matched after the multicall resolver runs, so one entry covers
   * that applet's aliases and its `/bin` and `/usr/bin` spellings. Entries must
   * therefore be canonical names: an alias or an applet path in the list
   * matches nothing and denies everything it was meant to allow.
   */
  readonly allowedCommands?: readonly string[];
  readonly maxMutations?: number;
}

export interface ShellLimits {
  maxScriptBytes: number;
  maxTotalSourceBytes: number;
  maxAstNodes: number;
  maxNestingDepth: number;
  maxCommands: number;
  maxSteps: number;
  maxLoopIterations: number;
  maxFunctionDepth: number;
  maxSourceDepth: number;
  maxScriptDepth: number;
  maxCommandSubstitutionBytes: number;
  maxPipelineBytes: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxMaterializedOutputBytes: number;
  maxTotalIoBytes: number;
  maxBufferedBytes: number;
  maxLineBytes: number;
  maxBufferedRecords: number;
  maxGlobMatches: number;
  maxExpansionWork: number;
  maxExpansionChars: number;
  maxExpansionFields: number;
  maxMutations: number;
  deadlineMs: number;
  outputIdleTimeoutMs: number;
}

export interface ShellCommandContext {
  fileSystem: ShellFileSystem;
  session: ShellSession;
  signal: AbortSignal;
  budget: ShellBudget;
  policy: ShellPolicy;
  executeSource(
    source: string,
    path: string,
    args: readonly string[],
    fds: ShellFileDescriptors,
  ): Promise<number>;
  /**
   * Runs one already-expanded command through the same registry, policy, and
   * budget as an ordinary simple command. `argv` is never re-parsed, so a
   * utility that builds an invocation from untrusted data cannot inject shell
   * syntax. The invoked status does not request errexit on its own.
   *
   * `options.bypassFunctions` skips shell-function lookup, which is what
   * `command NAME` means.
   */
  executeCommand(
    argv: readonly string[],
    fds: ShellFileDescriptors,
    options?: ExecuteCommandOptions,
  ): Promise<number>;
  /**
   * Reports how the shell would resolve `name`, without running it.
   *
   * Discovery utilities use this so they can never disagree with execution and
   * so they do not need to import the registry or the applet table themselves.
   */
  resolveCommand(name: string): ShellCommandResolution | undefined;
  /**
   * Runs a bounded source unit in an isolated child scope.
   *
   * The child inherits the environment, working directory, shell options,
   * policy, cancellation, and the execution-wide budget, and receives its own
   * positional parameters. Variables, functions, and working-directory changes
   * it makes do not reach the caller, and `exit` ends the child rather than the
   * caller. This is what running an executable script means; `executeSource`
   * remains the same-scope form `source` and `.` need.
   */
  executeScript(
    source: string,
    path: string,
    args: readonly string[],
    fds: ShellFileDescriptors,
  ): Promise<number>;
}

export interface ExecuteCommandOptions {
  readonly bypassFunctions?: boolean;
}

export type ShellCommandResolution =
  | { readonly kind: "function"; readonly name: string; readonly path?: undefined }
  | {
      readonly kind: "builtin" | "program";
      readonly name: string;
      readonly path: string | undefined;
    };

export interface ShellProcess {
  completed: Promise<{ exitCode: number }>;
}

export interface ShellCommand {
  readonly name: string;
  run(
    context: ShellCommandContext,
    argv: readonly string[],
    fds: ShellFileDescriptors,
  ): ShellProcess;
}

export interface ShellExecution {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  completed: Promise<{ exitCode: number }>;
  cancel(reason?: unknown): void;
}

export interface ExecuteStreamOptions {
  script: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  args?: readonly string[];
  stdin?: ReadableStream<Uint8Array>;
  signal?: AbortSignal;
}

export interface ExecuteTextOptions extends Omit<ExecuteStreamOptions, "stdin"> {
  stdin?: string | Uint8Array | ReadableStream<Uint8Array>;
}

export type RemoteExecuteTextOptions = Omit<ExecuteTextOptions, "signal">;

export interface ExecuteTextResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecuteBytesResult {
  exitCode: number;
  stdoutBytes: Uint8Array;
  stderrBytes: Uint8Array;
}

export interface ShellOptions {
  fileSystem: VirtualFileSystem;
  commands: readonly ShellCommand[];
  /**
   * How a bare command name reaches an applet.
   *
   * `"registry"`, the default, resolves every registered applet by its name
   * and ignores `PATH` entirely, so a `PATH` an application sets for its own
   * reasons cannot make commands disappear.
   *
   * `"path"` adds the Linux search: a `PATH` component must name a virtual
   * applet directory for an ordinary applet to resolve, while a built-in
   * resolves regardless, exactly as in Bash. Use it with the environment from
   * `@corca-ai/cf-vfs/shell/linux`; an absolute applet path such as `/bin/cat`
   * works under both settings.
   */
  commandResolution?: "registry" | "path";
  policy?: ShellPolicy;
  limits?: Partial<ShellLimits>;
  now?: () => number;
  /**
   * Observes bounded-execution events. Never invoked when omitted, and a
   * throwing sink cannot change an exit status or mask an error.
   */
  onEvent?: ShellEventSink;
}

export interface ShellBudget {
  readonly limits: ShellLimits;
  step(count?: number): void;
  command(): void;
  loop(): void;
  io(bytes: number): void;
  mutation(count?: number): void;
  glob(count?: number): void;
  expansionWork(count?: number): void;
  checkExpansionOutput(characters: number, fields?: number): void;
  expansionOutput(characters: number, fields?: number): void;
  buffered(bytes: number): () => void;
  checkDeadline(): void;
}

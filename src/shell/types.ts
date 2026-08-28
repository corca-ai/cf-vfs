import type { PosixCredentials, VfsStat, VirtualFileSystem } from "../vfs/types.js";
import type { OpaqueContentAccess, ShellContentReader } from "./content.js";
import type { ShellEventSink } from "./events.js";
import type { ShellIdentityResolver, ShellIdentitySource } from "./identity.js";
import type { NetworkAccess, ShellNetwork } from "./network.js";
import type { FunctionDefinitionNode } from "./parser.js";

export type ShellFileSystem = Pick<
  VirtualFileSystem,
  | "getMutationToken"
  | "stat"
  | "list"
  | "listPage"
  | "find"
  | "findPage"
  | "subtreeSummary"
  | "readFile"
  | "writeFile"
  | "appendFile"
  | "touch"
  | "setMetadata"
  | "setOwnership"
  | "mkdir"
  | "remove"
  | "move"
  | "copy"
  | "lstat"
  | "readlink"
  | "symlink"
  | "realpath"
> & {
  inspectWriteTarget(path: string): VfsStat | null;
  /**
   * Enforces the declared roots without reading or writing anything.
   *
   * A path that is answered outside this interface — a virtual device — still
   * has to pass the same check, and saying so outright beats calling a reading
   * method for its side effect.
   */
  assertReadable(path: string): void;
  assertWritable(path: string): void;
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
  /** Immutable authorization identity supplied by the host. */
  credentials?: Readonly<Required<PosixCredentials>>;
  /** Creation mask for this shell session. */
  umask: number;
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
   * How much of an opaque R2 body a session may read.
   *
   * Independent of the read roots because it is a different question: the
   * roots say which paths a session can name, and this says whether the bytes
   * behind an opaque one may be streamed on the workspace's R2 budget.
   * `metadata` — the default — keeps the behavior every existing caller has:
   * `ls` and `stat` see the entry, and reading it is `ENOTSUP`.
   */
  readonly opaqueContent?: OpaqueContentAccess;
  /**
   * Whether this session may use the host's network capability.
   *
   * `off` — the default — refuses with `ENOTSUP` before a request is built, so
   * a host that has a network still hands out sessions that do not. Read and
   * write roots say nothing here: a root bounds which paths a session can name,
   * and this bounds whether it can reach anything that is not a path.
   */
  readonly network?: NetworkAccess;
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
  /** Host-supplied account-name lookup, cached for this execution. */
  identities?: ShellIdentitySource | undefined;
  /**
   * Streams an opaque body, when the session was built with the capability.
   *
   * Absent by default, which is what keeps an inline-only shell from carrying
   * any R2 code at all.
   */
  content?: ShellContentReader | undefined;
  /**
   * Reaches outside the namespace, when the session was built with it.
   *
   * Absent by default, which is what keeps this an isolated environment: a
   * networked command refuses before anything leaves the object.
   */
  network?: ShellNetwork | undefined;
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
   * It is asynchronous because resolution may consult the namespace for an
   * executable file, and it classifies without reading one.
   */
  resolveCommand(name: string): Promise<ShellCommandResolution | undefined>;
  /**
   * Describes every registered applet, in UTF-8 byte order by name.
   *
   * Help and completion need the whole set, and taking it from the active
   * registry keeps them from importing the applet table themselves.
   */
  listCommands(): readonly ShellCommandDescription[];
  /**
   * The execution's clock, in milliseconds since the epoch.
   *
   * Injected so a test can pin it and so nothing reads a host clock directly.
   * On Workers it advances only across I/O, which is why no command may use it
   * as a bound; see the deadline note in the operations documentation.
   */
  now(): number;

  /**
   * Runs a bounded source unit in an isolated child scope.
   *
   * The child inherits the environment, working directory, shell options,
   * policy, cancellation, and the execution-wide budget, and receives its own
   * positional parameters. Variables, functions, and working-directory changes
   * it makes do not reach the caller, and `exit` ends the child rather than the
   * caller. This is what running an executable script means; `executeSource`
   * remains the same-scope form `source` and `.` need.
   *
   * `name` becomes `$0`. It is the spelling the caller used, not a resolved
   * path, so a script sees what Bash would hand it.
   */
  executeScript(
    source: string,
    name: string,
    args: readonly string[],
    fds: ShellFileDescriptors,
  ): Promise<number>;
  /**
   * Runs a bounded VFS file as a script in an isolated child scope.
   *
   * Returns `undefined` when nothing is at that path, so the caller decides the
   * diagnostic and reports 127; a file that exists but cannot run raises the
   * same `ENOEXEC` or `EACCES` failure an executable file would, which is
   * status 126. The executable mode bit is not required: naming the interpreter
   * is the authorization.
   */
  executeScriptFile(
    path: string,
    args: readonly string[],
    fds: ShellFileDescriptors,
    invokedAs?: string,
  ): Promise<number | undefined>;
}

export interface ExecuteCommandOptions {
  readonly bypassFunctions?: boolean;
}

export interface ShellCommandDescription {
  readonly name: string;
  readonly kind: "builtin" | "program" | "session-builtin";
  /** Operand syntax, or `""` when the applet takes none. */
  readonly usage: string;
  readonly summary: string;
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
  /**
   * Numeric authorization identity. When present, the filesystem must support
   * a POSIX user view; environment variables never substitute for it.
   */
  credentials?: PosixCredentials;
  /** Permission bits removed from newly created files. Defaults to `022`. */
  umask?: number;
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
  /**
   * Resolves numeric IDs and account names for presentation-oriented commands.
   *
   * The resolver is not an authorization source: filesystem access continues
   * to use only the execution's numeric credentials.
   */
  identityResolver?: ShellIdentityResolver;
  /**
   * The capability that lets streaming commands read opaque R2 bodies.
   *
   * Supplying it is the opt-in; `policy.opaqueContent` decides whether a given
   * session may use it. Both are required, so adding the capability to a host
   * does not silently widen what an existing sandboxed session can read.
   */
  content?: ShellContentReader;
  /**
   * The capability that lets commands reach the network.
   *
   * Supplying it is the opt-in; `policy.network` decides whether a given
   * session may use it. Both are required, so adding a network to a host does
   * not quietly give one to every sandboxed session already running on it.
   */
  network?: ShellNetwork;
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
  remainingDeadlineMs(): number;
}

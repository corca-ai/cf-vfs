import type { Awaitable, VfsStat, VirtualFileSystem } from "../vfs/types.js";
import type { FunctionDefinitionNode } from "./parser.js";

export type ShellFileSystem = Pick<
  VirtualFileSystem,
  | "getMutationToken"
  | "stat"
  | "list"
  | "listPage"
  | "find"
  | "findPage"
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
  inspectWriteTarget(path: string): Awaitable<VfsStat | null>;
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
  nounset?: boolean;
  functions: Map<string, FunctionDefinitionNode>;
  functionDepth: number;
  sourceDepth: number;
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
  | { type: "return"; status: number }
  | { type: "break" | "continue"; levels: number };

export interface ShellPolicy {
  readonly readRoots?: readonly string[];
  readonly writeRoots?: readonly string[];
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
}

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
  policy?: ShellPolicy;
  limits?: Partial<ShellLimits>;
  now?: () => number;
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

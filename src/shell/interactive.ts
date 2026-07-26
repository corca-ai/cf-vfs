import { VfsError } from "../core/errors.js";
import { DEFAULT_SHELL_LIMITS } from "./budget.js";
import { type CompletionLimits, type CompletionResult, completeShellLine } from "./completion.js";
import { isIncompleteShellSyntaxError, parseShellScript } from "./parser.js";
import {
  createShellSession,
  prepareShellSessionUnit,
  type ShellSessionOptions,
} from "./session.js";
import { Shell } from "./shell.js";
import type {
  ExecuteBytesResult,
  ExecuteStreamOptions,
  ExecuteTextOptions,
  ExecuteTextResult,
  ShellExecution,
  ShellLimits,
  ShellOptions,
  ShellSession,
} from "./types.js";

export interface InteractiveShellOptions extends ShellOptions, ShellSessionOptions {}

export type InteractiveExecuteStreamOptions = Omit<
  ExecuteStreamOptions,
  "cwd" | "env" | "args" | "credentials" | "umask"
>;

export type InteractiveExecuteTextOptions = Omit<
  ExecuteTextOptions,
  "cwd" | "env" | "args" | "credentials" | "umask"
>;

function interactiveUnitOptions<Options extends ExecuteStreamOptions | ExecuteTextOptions>(
  options: Options,
): Omit<Options, "cwd" | "env" | "args" | "credentials" | "umask"> {
  const { cwd, env, args, credentials, umask, ...unitOptions } = options;
  if (
    cwd !== undefined ||
    env !== undefined ||
    args !== undefined ||
    credentials !== undefined ||
    umask !== undefined
  ) {
    throw new VfsError(
      "EINVAL",
      "interactive execution context belongs in the InteractiveShell constructor",
    );
  }
  return unitOptions;
}

export interface InteractiveShellSnapshot {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly args: readonly string[];
  readonly lastExitCode: number;
  readonly pipefail: boolean;
  readonly errexit: boolean;
  readonly nounset: boolean;
}

export class InteractiveShell extends Shell {
  private readonly session: ShellSession;
  private active = false;
  private closed = false;

  constructor(options: InteractiveShellOptions) {
    const { cwd, env, args, credentials, umask, ...shellOptions } = options;
    super(shellOptions);
    this.session = createShellSession({
      ...(cwd === undefined ? {} : { cwd }),
      ...(env === undefined ? {} : { env }),
      ...(args === undefined ? {} : { args }),
      ...(credentials === undefined ? {} : { credentials }),
      ...(umask === undefined ? {} : { umask }),
    });
  }

  get cwd(): string {
    return this.session.cwd;
  }

  get lastExitCode(): number {
    return this.session.lastExitCode;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Offers what could come next at the cursor of a partly typed line.
   *
   * Runs against this session's working directory and environment, so a
   * completion reflects where the user actually is. The registry is the one
   * this shell was built with — completion never widens it.
   *
   * Bounded by construction: candidates returned, namespace entries examined,
   * and the length of a word worth working on all have caps, and the result
   * says what it scanned and whether a cap stopped it.
   */
  complete(line: string, cursor: number, limits?: Partial<CompletionLimits>): CompletionResult {
    const source = this.completionSource(this.session);
    return completeShellLine(line, cursor, {
      commands: source.commands,
      appletDirectories: source.appletDirectories,
      fileSystem: source.fileSystem,
      cwd: this.session.cwd,
      env: Object.fromEntries(this.session.env),
      ...(limits === undefined ? {} : { limits }),
    });
  }

  /**
   * Sets one variable in this session's environment.
   *
   * For values a host learns after the session started and a script can only
   * read as a variable — `COLUMNS` and `LINES` are the reason this exists.
   * Nothing here implies a terminal: it is one string a script may read.
   */
  setEnv(name: string, value: string): void {
    this.session.env.set(name, value);
  }

  snapshot(): InteractiveShellSnapshot {
    return Object.freeze({
      cwd: this.session.cwd,
      env: Object.freeze(Object.fromEntries(this.session.env)),
      args: Object.freeze([...this.session.args]),
      lastExitCode: this.session.lastExitCode,
      pipefail: this.session.pipefail,
      errexit: this.session.errexit === true,
      nounset: this.session.nounset === true,
    });
  }

  override executeStream(options: ExecuteStreamOptions): ShellExecution {
    return this.runStream(interactiveUnitOptions(options));
  }

  override async executeText(options: ExecuteTextOptions): Promise<ExecuteTextResult> {
    return this.runText(interactiveUnitOptions(options));
  }

  override async executeBytes(options: ExecuteTextOptions): Promise<ExecuteBytesResult> {
    return this.runBytes(interactiveUnitOptions(options));
  }

  runStream(options: InteractiveExecuteStreamOptions): ShellExecution {
    this.beginUnit();
    let execution: ShellExecution;
    try {
      execution = this.executeSessionStream(options, this.session);
    } catch (error) {
      this.finishUnit();
      throw error;
    }
    return {
      ...execution,
      completed: execution.completed.finally(() => this.finishUnit()),
    };
  }

  async runText(options: InteractiveExecuteTextOptions): Promise<ExecuteTextResult> {
    this.beginUnit();
    try {
      return await this.executeSessionText(options, this.session);
    } finally {
      this.finishUnit();
    }
  }

  async runBytes(options: InteractiveExecuteTextOptions): Promise<ExecuteBytesResult> {
    this.beginUnit();
    try {
      return await this.executeSessionBytes(options, this.session);
    } finally {
      this.finishUnit();
    }
  }

  private beginUnit(): void {
    if (this.closed) throw new VfsError("EINVAL", "interactive shell is closed");
    if (this.active) {
      throw new VfsError("EAGAIN", "interactive shell already has an active execution");
    }
    prepareShellSessionUnit(this.session);
    this.active = true;
  }

  private finishUnit(): void {
    this.closed ||= this.session.exitRequested;
    this.active = false;
  }
}

export interface InteractiveInputBufferOptions {
  limits?: Partial<Pick<ShellLimits, "maxAstNodes" | "maxNestingDepth">>;
}

export type InteractiveInputResult =
  | { readonly status: "incomplete" }
  | { readonly status: "ready"; readonly source: string };

function hasTrailingLineContinuation(line: string): boolean {
  let quote: "'" | '"' | undefined;
  let boundary = true;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === "'") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (character === "\\") {
      if (index === line.length - 1) return true;
      index += 1;
      boundary = false;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      boundary = false;
      continue;
    }
    if (character === "#" && boundary) return false;
    boundary =
      character === " " ||
      character === "\t" ||
      character === "\r" ||
      ";\n|&<>(){}".includes(character ?? "");
  }
  return false;
}

export class InteractiveInputBuffer {
  private readonly maximumNodes: number;
  private readonly maximumDepth: number;
  private source = "";

  constructor(options: InteractiveInputBufferOptions = {}) {
    this.maximumNodes = options.limits?.maxAstNodes ?? DEFAULT_SHELL_LIMITS.maxAstNodes;
    this.maximumDepth = options.limits?.maxNestingDepth ?? DEFAULT_SHELL_LIMITS.maxNestingDepth;
  }

  get hasPendingSource(): boolean {
    return this.source.length > 0;
  }

  push(line: string): InteractiveInputResult {
    this.source += `${line}\n`;
    if (hasTrailingLineContinuation(line)) return { status: "incomplete" };
    try {
      parseShellScript(this.source, this.maximumNodes, this.maximumDepth);
    } catch (error) {
      if (isIncompleteShellSyntaxError(error)) return { status: "incomplete" };
      if (!(error instanceof VfsError)) throw error;
    }
    const source = this.source;
    this.source = "";
    return { status: "ready", source };
  }

  clear(): void {
    this.source = "";
  }
}

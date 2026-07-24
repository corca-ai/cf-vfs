import { VfsError } from "../core/errors.js";
import { DEFAULT_SHELL_LIMITS } from "./budget.js";
import {
  isIncompleteShellSyntaxError,
  parseShellScript,
} from "./parser.js";
import { createShellSession, prepareShellSessionUnit } from "./session.js";
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

export interface InteractiveShellOptions extends ShellOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  args?: readonly string[];
}

export type InteractiveExecuteStreamOptions = Omit<
  ExecuteStreamOptions,
  "cwd" | "env" | "args"
>;

export type InteractiveExecuteTextOptions = Omit<
  ExecuteTextOptions,
  "cwd" | "env" | "args"
>;

function interactiveUnitOptions<
  Options extends ExecuteStreamOptions | ExecuteTextOptions,
>(options: Options): Omit<Options, "cwd" | "env" | "args"> {
  const { cwd, env, args, ...unitOptions } = options;
  if (cwd !== undefined || env !== undefined || args !== undefined) {
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
    const { cwd, env, args, ...shellOptions } = options;
    super(shellOptions);
    this.session = createShellSession({
      ...(cwd === undefined ? {} : { cwd }),
      ...(env === undefined ? {} : { env }),
      ...(args === undefined ? {} : { args }),
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
  let quote: "'" | "\"" | undefined;
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
    if (quote === "\"") {
      if (character === "\"") quote = undefined;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      boundary = false;
      continue;
    }
    if (character === "#" && boundary) return false;
    boundary = character === " " || character === "\t" || character === "\r"
      || ";\n|&<>(){}".includes(character ?? "");
  }
  return false;
}

export class InteractiveInputBuffer {
  private readonly maximumNodes: number;
  private readonly maximumDepth: number;
  private source = "";

  constructor(options: InteractiveInputBufferOptions = {}) {
    this.maximumNodes = options.limits?.maxAstNodes ?? DEFAULT_SHELL_LIMITS.maxAstNodes;
    this.maximumDepth = options.limits?.maxNestingDepth
      ?? DEFAULT_SHELL_LIMITS.maxNestingDepth;
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

import type { Awaitable, VirtualFileSystem } from "./types.js";

export interface CommandContext {
  cwd: string;
  fileSystem: VirtualFileSystem;
}

export interface CommandPayload<Data = unknown> {
  stdout?: string;
  data: Data;
}

export interface CommandDefinition {
  readonly name: string;
  execute(context: CommandContext, input: unknown): Awaitable<CommandPayload>;
}

export type CommandOutputMode = "both" | "structured" | "text";

export interface ExecuteRequest {
  command: string;
  cwd?: string;
  input?: unknown;
  maxOutputBytes?: number;
  output?: CommandOutputMode;
}

export interface ExecuteResult {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  data: unknown;
  truncated: boolean;
}

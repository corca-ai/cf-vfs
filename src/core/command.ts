import type { Awaitable, VirtualFileSystem } from "./types.js";

export interface CommandContext {
  cwd: string;
  fileSystem: VirtualFileSystem;
  maxInputBytes: number;
  stdin: string;
}

export interface CommandPayload<Data = unknown> {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  data: Data;
}

export interface CommandDefinition {
  readonly name: string;
  execute(context: CommandContext, input: unknown): Awaitable<CommandPayload>;
}

export const COMMAND_OUTPUT_MODES = ["both", "structured", "text"] as const;
export type CommandOutputMode = typeof COMMAND_OUTPUT_MODES[number];

export interface ExecuteRequest {
  command: string;
  cwd?: string;
  input?: unknown;
  stdin?: string;
  maxInputBytes?: number;
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

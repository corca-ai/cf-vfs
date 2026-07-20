import type {
  CommandDefinition,
  CommandOutputMode,
  ExecuteRequest,
  ExecuteResult,
} from "./command.js";
import { COMMAND_OUTPUT_MODES } from "./command.js";
import { isVfsError, VfsError } from "./errors.js";
import { normalizePath } from "./path.js";
import type { VirtualFileSystem } from "./types.js";

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const HARD_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024;
const HARD_MAX_INPUT_BYTES = 8 * 1024 * 1024;

function byteLimit(value: unknown, fallback: number, hardMaximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (typeof resolved !== "number" || !Number.isInteger(resolved) || resolved < 0) {
    throw new VfsError("EINVAL", `${name} must be a non-negative integer`);
  }
  return Math.min(resolved, hardMaximum);
}

function commandStdin(value: unknown, maximumBytes: number): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new VfsError("EINVAL", "stdin must be a string");
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > maximumBytes) {
    throw new VfsError("E2BIG", `stdin exceeds the ${maximumBytes}-byte input limit`);
  }
  return value;
}

function truncateUtf8(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(value);
  if (encoded.byteLength <= maximumBytes) return { value, truncated: false };

  let end = maximumBytes;
  while (end > 0) {
    const byte = encoded[end];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) break;
    end -= 1;
  }
  return {
    value: new TextDecoder().decode(encoded.slice(0, end)),
    truncated: true,
  };
}

function outputMode(value: unknown): CommandOutputMode {
  if (value === undefined) return "both";
  const mode = COMMAND_OUTPUT_MODES.find((candidate) => candidate === value);
  if (mode !== undefined) return mode;
  throw new VfsError("EINVAL", "output must be both, structured, or text");
}

export class CommandExecutor {
  private readonly commands: ReadonlyMap<string, CommandDefinition>;
  private readonly fileSystem: VirtualFileSystem;

  constructor(fileSystem: VirtualFileSystem, commands: readonly CommandDefinition[]) {
    const commandMap = new Map<string, CommandDefinition>();
    for (const command of commands) {
      if (commandMap.has(command.name)) {
        throw new Error(`duplicate command: ${command.name}`);
      }
      commandMap.set(command.name, command);
    }
    this.commands = commandMap;
    this.fileSystem = fileSystem;
  }

  async execute(request: ExecuteRequest): Promise<ExecuteResult> {
    const cwd = normalizePath(request.cwd ?? "/");
    const command = this.commands.get(request.command);
    if (!command) {
      return {
        command: request.command,
        cwd,
        exitCode: 127,
        stdout: "",
        stderr: `${request.command}: command not found`,
        data: null,
        truncated: false,
      };
    }

    try {
      const maximumOutputBytes = byteLimit(
        request.maxOutputBytes,
        DEFAULT_MAX_OUTPUT_BYTES,
        HARD_MAX_OUTPUT_BYTES,
        "maxOutputBytes",
      );
      const maximumInputBytes = byteLimit(
        request.maxInputBytes,
        DEFAULT_MAX_INPUT_BYTES,
        HARD_MAX_INPUT_BYTES,
        "maxInputBytes",
      );
      const stdin = commandStdin(request.stdin, maximumInputBytes);
      const mode = outputMode(request.output);
      const payload = await command.execute(
        { cwd, fileSystem: this.fileSystem, maxInputBytes: maximumInputBytes, stdin },
        request.input,
      );
      const output = truncateUtf8(payload.stdout ?? "", maximumOutputBytes);
      return {
        command: command.name,
        cwd,
        exitCode: payload.exitCode ?? 0,
        stdout: mode === "structured" ? "" : output.value,
        stderr: payload.stderr ?? "",
        data: mode === "text" ? null : payload.data,
        truncated: output.truncated,
      };
    } catch (error) {
      if (!isVfsError(error)) throw error;
      return {
        command: command.name,
        cwd,
        exitCode: error.code === "EINVAL" ? 2 : 1,
        stdout: "",
        stderr: `${command.name}: ${error.message}`,
        data: { code: error.code, path: error.path ?? null },
        truncated: false,
      };
    }
  }
}

import type {
  CommandDefinition,
  CommandOutputMode,
  ExecuteRequest,
  ExecuteResult,
} from "./command.js";
import { isVfsError, VfsError } from "./errors.js";
import { normalizePath } from "./path.js";
import type { VirtualFileSystem } from "./types.js";

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const HARD_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function truncateUtf8(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(value);
  if (encoded.byteLength <= maximumBytes) return { value, truncated: false };

  let end = maximumBytes;
  while (end > 0 && (encoded[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  return {
    value: new TextDecoder().decode(encoded.slice(0, end)),
    truncated: true,
  };
}

function outputMode(value: unknown): CommandOutputMode {
  if (value === undefined) return "both";
  if (value === "both" || value === "structured" || value === "text") return value;
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
      const maximumBytes = Math.min(
        Math.max(request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 0),
        HARD_MAX_OUTPUT_BYTES,
      );
      const mode = outputMode(request.output);
      const payload = await command.execute(
        { cwd, fileSystem: this.fileSystem },
        request.input,
      );
      const output = truncateUtf8(payload.stdout ?? "", maximumBytes);
      return {
        command: command.name,
        cwd,
        exitCode: 0,
        stdout: mode === "structured" ? "" : output.value,
        stderr: "",
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

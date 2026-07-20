import { VfsDurableObject } from "../vfs/durable-object.js";
import type { DurableObjectFileSystemOptions } from "../vfs/do-sql.js";
import { Shell } from "./shell.js";
import { VfsError } from "../core/errors.js";
import { rpcByteBody, rpcString } from "../vfs/rpc-validation.js";
import type {
  ExecuteTextResult,
  ExecuteBytesResult,
  RemoteExecuteTextOptions,
  ShellCommand,
  ShellLimits,
  ShellPolicy,
} from "./types.js";

export interface ShellDurableObjectOptions extends DurableObjectFileSystemOptions {
  commands: readonly ShellCommand[];
  policy?: ShellPolicy;
  limits?: Partial<ShellLimits>;
}

export interface ExecuteToOptions {
  script: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  args?: readonly string[];
  stdin: ReadableStream<Uint8Array>;
  stdout: WritableStream<Uint8Array>;
  stderr: WritableStream<Uint8Array>;
}

function remoteTextOptions(
  value: unknown,
  additionalKeys: readonly string[] = [],
): RemoteExecuteTextOptions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new VfsError("EINVAL", "options must be an object");
  }
  const input = value as Readonly<Record<string, unknown>>;
  const extra = Object.keys(input).find((key) =>
    !["script", "cwd", "env", "args", "stdin", ...additionalKeys].includes(key));
  if (extra !== undefined) throw new VfsError("EINVAL", `options.${extra} is not supported`);
  const env = input["env"];
  if (env !== undefined && (env === null || typeof env !== "object" || Array.isArray(env))) {
    throw new VfsError("EINVAL", "options.env must be a string record");
  }
  if (env !== undefined && Object.values(env).some((item) => typeof item !== "string")) {
    throw new VfsError("EINVAL", "options.env values must be strings");
  }
  const args = input["args"];
  if (args !== undefined && (!Array.isArray(args) || args.some((item) => typeof item !== "string"))) {
    throw new VfsError("EINVAL", "options.args must be an array of strings");
  }
  const stdin = input["stdin"];
  const body = stdin === undefined ? undefined : rpcByteBody(stdin);
  if (body !== undefined && !(typeof body === "string" || body instanceof Uint8Array || body instanceof ReadableStream)) {
    throw new VfsError("EINVAL", "options.stdin must be text, bytes, or a byte stream");
  }
  return {
    script: rpcString(input["script"], "options.script"),
    ...(input["cwd"] === undefined ? {} : { cwd: rpcString(input["cwd"], "options.cwd") }),
    ...(env === undefined ? {} : { env: env as Readonly<Record<string, string>> }),
    ...(args === undefined ? {} : { args: args as readonly string[] }),
    ...(body === undefined ? {} : { stdin: body }),
  };
}

function remoteExecuteToOptions(value: unknown): ExecuteToOptions {
  const common = remoteTextOptions(value, ["stdout", "stderr"]);
  const input = value as Readonly<Record<string, unknown>>;
  if (!(common.stdin instanceof ReadableStream)) {
    throw new VfsError("EINVAL", "options.stdin must be a byte stream");
  }
  if (!(input["stdout"] instanceof WritableStream) || !(input["stderr"] instanceof WritableStream)) {
    throw new VfsError("EINVAL", "options.stdout and options.stderr must be byte sinks");
  }
  return {
    ...common,
    stdin: common.stdin,
    stdout: input["stdout"],
    stderr: input["stderr"],
  };
}

export abstract class ShellDurableObject<Environment> extends VfsDurableObject<Environment> {
  protected readonly shell: Shell;

  protected constructor(
    ctx: DurableObjectState,
    env: Environment,
    options: ShellDurableObjectOptions,
  ) {
    super(ctx, env, options);
    this.shell = new Shell({
      fileSystem: this.fileSystem,
      commands: options.commands,
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    });
  }

  executeText(options: RemoteExecuteTextOptions): Promise<ExecuteTextResult> {
    return this.shell.executeText(remoteTextOptions(options));
  }

  executeBytes(options: RemoteExecuteTextOptions): Promise<ExecuteBytesResult> {
    return this.shell.executeBytes(remoteTextOptions(options));
  }

  async executeTo(options: ExecuteToOptions): Promise<{ exitCode: number }> {
    options = remoteExecuteToOptions(options);
    const execution = this.shell.executeStream({
      script: options.script,
      stdin: options.stdin,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.args === undefined ? {} : { args: options.args }),
    });
    const completed = execution.completed;
    const stdout = execution.stdout.pipeTo(options.stdout);
    const stderr = execution.stderr.pipeTo(options.stderr);
    try {
      const [result] = await Promise.all([completed, stdout, stderr]);
      return result;
    } catch (error) {
      execution.cancel(error);
      await Promise.allSettled([completed, stdout, stderr]);
      throw error;
    }
  }
}

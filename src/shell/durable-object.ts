import { VfsError } from "../core/errors.js";
import type { DurableObjectFileSystem, DurableObjectFileSystemOptions } from "../vfs/do-sql.js";
import { VfsDurableObject } from "../vfs/durable-object.js";
import type { VfsEvent } from "../vfs/events.js";
import {
  rpcByteBody,
  rpcOptionalNonnegativeInteger,
  rpcOptionalStringArray,
  rpcOptionalStringRecord,
  rpcPosixCredentials,
  rpcRecord,
  rpcString,
} from "../vfs/rpc-validation.js";
import type { PosixCredentials } from "../vfs/types.js";
import type { ShellContentReader } from "./content.js";
import type { ShellEvent } from "./events.js";
import type { ShellIdentityResolver } from "./identity.js";
import type { ShellNetwork } from "./network.js";
import { Shell } from "./shell.js";
import type {
  ExecuteBytesResult,
  ExecuteTextResult,
  RemoteExecuteTextOptions,
  ShellCommand,
  ShellLimits,
  ShellPolicy,
} from "./types.js";

export interface ShellDurableObjectOptions extends Omit<DurableObjectFileSystemOptions, "onEvent"> {
  commands: readonly ShellCommand[];
  /**
   * Lets streaming commands read opaque R2 bodies.
   *
   * Supplied as a factory because the reader needs the filesystem this object
   * owns, which does not exist until the constructor has run. Handing one in
   * is only half the opt-in; `policy.opaqueContent` decides whether a session
   * may use it.
   */
  content?: (fileSystem: DurableObjectFileSystem) => ShellContentReader;
  /**
   * Resolves account names outside the filesystem's numeric authorization
   * model. The factory runs inside the object and is never accepted over RPC.
   */
  identityResolver?: (fileSystem: DurableObjectFileSystem) => ShellIdentityResolver;
  /**
   * Lets commands reach outside the namespace.
   *
   * The other half of the opt-in is `policy.network`, exactly as with the
   * content reader: an object that has a network still runs sessions that do
   * not.
   */
  network?: ShellNetwork;
  policy?: ShellPolicy;
  limits?: Partial<ShellLimits>;
  /** Observes storage and execution events from this object's single hook. */
  onEvent?: (event: VfsEvent | ShellEvent) => void;
}

export interface ExecuteToOptions {
  script: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  args?: readonly string[];
  credentials?: PosixCredentials;
  umask?: number;
  stdin: ReadableStream<Uint8Array>;
  stdout: WritableStream<Uint8Array>;
  stderr: WritableStream<Uint8Array>;
}

function remoteTextOptions(
  value: unknown,
  additionalKeys: readonly string[] = [],
): RemoteExecuteTextOptions {
  const input = rpcRecord(value, "options");
  const extra = Object.keys(input).find(
    (key) =>
      ![
        "script",
        "cwd",
        "env",
        "args",
        "stdin",
        "credentials",
        "umask",
        ...additionalKeys,
      ].includes(key),
  );
  if (extra !== undefined) throw new VfsError("EINVAL", `options.${extra} is not supported`);
  const env = rpcOptionalStringRecord(input["env"], "options.env");
  const args = rpcOptionalStringArray(input["args"], "options.args");
  const stdin = input["stdin"];
  const body = stdin === undefined ? undefined : rpcByteBody(stdin);
  if (
    body !== undefined &&
    !(typeof body === "string" || body instanceof Uint8Array || body instanceof ReadableStream)
  ) {
    throw new VfsError("EINVAL", "options.stdin must be text, bytes, or a byte stream");
  }
  const credentials = rpcPosixCredentials(input["credentials"], "options.credentials");
  const umask = rpcOptionalNonnegativeInteger(input["umask"], "options.umask");
  return {
    script: rpcString(input["script"], "options.script"),
    ...(input["cwd"] === undefined ? {} : { cwd: rpcString(input["cwd"], "options.cwd") }),
    ...(env === undefined ? {} : { env }),
    ...(args === undefined ? {} : { args }),
    ...(body === undefined ? {} : { stdin: body }),
    ...(credentials === undefined ? {} : { credentials }),
    ...(umask === undefined ? {} : { umask }),
  };
}

function remoteExecuteToOptions(value: unknown): ExecuteToOptions {
  const common = remoteTextOptions(value, ["stdout", "stderr"]);
  const input = rpcRecord(value, "options");
  if (!(common.stdin instanceof ReadableStream)) {
    throw new VfsError("EINVAL", "options.stdin must be a byte stream");
  }
  if (
    !(input["stdout"] instanceof WritableStream) ||
    !(input["stderr"] instanceof WritableStream)
  ) {
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
      ...(options.content === undefined ? {} : { content: options.content(this.fileSystem) }),
      ...(options.identityResolver === undefined
        ? {}
        : { identityResolver: options.identityResolver(this.fileSystem) }),
      ...(options.network === undefined ? {} : { network: options.network }),
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
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
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      ...(options.umask === undefined ? {} : { umask: options.umask }),
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

import { VfsError } from "../core/errors.js";
import type { RpcKeySet, RpcRecord } from "../vfs/rpc-validation.js";
import {
  rpcByteBody,
  rpcOptionalNonnegativeInteger,
  rpcOptionalStringArray,
  rpcOptionalStringRecord,
  rpcPosixCredentials,
  rpcString,
  rpcStruct,
} from "../vfs/rpc-validation.js";
import type { RemoteExecuteTextOptions } from "./types.js";

const REMOTE_TEXT_OPTION_KEYS = {
  script: true,
  cwd: true,
  env: true,
  args: true,
  stdin: true,
  credentials: true,
  umask: true,
} as const satisfies RpcKeySet<RemoteExecuteTextOptions>;

const REMOTE_EXECUTE_TO_OPTION_KEYS = {
  ...REMOTE_TEXT_OPTION_KEYS,
  stdout: true,
  stderr: true,
} as const satisfies RpcKeySet<ExecuteToOptions>;

export interface ExecuteToOptions extends Omit<RemoteExecuteTextOptions, "stdin"> {
  stdin: ReadableStream<Uint8Array>;
  stdout: WritableStream<Uint8Array>;
  stderr: WritableStream<Uint8Array>;
}

function parseTextOptions(input: RpcRecord): RemoteExecuteTextOptions {
  const env = rpcOptionalStringRecord(input["env"], "options.env");
  const args = rpcOptionalStringArray(input["args"], "options.args");
  const stdin = input["stdin"];
  const body = stdin === undefined ? undefined : rpcByteBody(stdin, "options.stdin");
  if (
    body !== undefined &&
    !(typeof body === "string" || body instanceof Uint8Array || body instanceof ReadableStream)
  ) {
    throw new VfsError("EINVAL", "options.stdin must be text, bytes, or a byte stream");
  }
  const credentials = rpcPosixCredentials(input["credentials"], "options.credentials");
  const umask = rpcOptionalNonnegativeInteger(input["umask"], "options.umask");
  if (umask !== undefined && umask > 0o777) {
    throw new VfsError("EINVAL", "options.umask must be an integer between 000 and 777");
  }
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

export function parseRemoteTextOptions(value: unknown): RemoteExecuteTextOptions {
  return parseTextOptions(rpcStruct(value, "options", REMOTE_TEXT_OPTION_KEYS));
}

export function parseRemoteExecuteToOptions(value: unknown): ExecuteToOptions {
  const input = rpcStruct(value, "options", REMOTE_EXECUTE_TO_OPTION_KEYS);
  const common = parseTextOptions(input);
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

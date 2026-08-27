import { VfsError } from "../core/errors.js";
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
import type { RemoteExecuteTextOptions } from "./types.js";

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

export function parseRemoteTextOptions(
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
  const body = stdin === undefined ? undefined : rpcByteBody(stdin, "options.stdin");
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

export function parseRemoteExecuteToOptions(value: unknown): ExecuteToOptions {
  const common = parseRemoteTextOptions(value, ["stdout", "stderr"]);
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

import { VfsError } from "../core/errors.js";
import type {
  AppendFileOptions,
  BeginOpaqueUploadOptions,
  ByteBody,
  CommitOpaqueUploadOptions,
  CopyOptions,
  FindOptions,
  MetadataUpdateOptions,
  MoveOptions,
  PageOptions,
  RemoveOptions,
  TouchOptions,
  WriteFileOptions,
} from "./types.js";

interface UnknownRecord extends Readonly<Record<string, unknown>> {
  readonly path?: unknown;
  readonly cursor?: unknown;
  readonly limit?: unknown;
  readonly includeRoot?: unknown;
  readonly maxDepth?: unknown;
  readonly name?: unknown;
  readonly pathGlob?: unknown;
  readonly type?: unknown;
  readonly createParents?: unknown;
  readonly disposition?: unknown;
  readonly ifRevision?: unknown;
  readonly ifMutationToken?: unknown;
  readonly mode?: unknown;
  readonly modifiedAtMs?: unknown;
  readonly create?: unknown;
  readonly recursive?: unknown;
  readonly replace?: unknown;
  readonly expectedSizeBytes?: unknown;
  readonly expiresInMs?: unknown;
  readonly contentType?: unknown;
  readonly verifiedSha256?: unknown;
}

function record(value: unknown, name: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new VfsError("EINVAL", `${name} must be an object`);
  }
  return value as UnknownRecord;
}

function keys(value: UnknownRecord, allowed: readonly string[], name: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new VfsError("EINVAL", `${name}.${extra} is not supported`);
}

export function rpcString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new VfsError("EINVAL", `${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : rpcString(value, name);
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new VfsError("EINVAL", `${name} must be a boolean`);
  return value;
}

function optionalInteger(value: unknown, name: string, minimum = 0): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new VfsError("EINVAL", `${name} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

export function rpcOptionalPositiveInteger(value: unknown, name: string): number | undefined {
  return optionalInteger(value, name, 1);
}

export function rpcOptionalNonnegativeInteger(value: unknown, name: string): number | undefined {
  return optionalInteger(value, name);
}

function guardOptions(input: UnknownRecord): {
  ifRevision?: number;
  ifMutationToken?: string;
} {
  const ifRevision = optionalInteger(input.ifRevision, "options.ifRevision", 1);
  const ifMutationToken = optionalString(input.ifMutationToken, "options.ifMutationToken");
  return {
    ...(ifRevision === undefined ? {} : { ifRevision }),
    ...(ifMutationToken === undefined ? {} : { ifMutationToken }),
  };
}

export function rpcByteBody(value: unknown): ByteBody {
  if (
    typeof value === "string"
    || value instanceof ArrayBuffer
    || ArrayBuffer.isView(value)
    || value instanceof ReadableStream
  ) return value;
  throw new VfsError("EINVAL", "body must be bytes, text, or a byte stream");
}

export function rpcPageOptions(value: unknown): PageOptions | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "options");
  keys(input, ["cursor", "limit"], "options");
  const cursor = optionalString(input.cursor, "options.cursor");
  const limit = rpcOptionalPositiveInteger(input.limit, "options.limit");
  return { ...(cursor === undefined ? {} : { cursor }), ...(limit === undefined ? {} : { limit }) };
}

export function rpcFindOptions(value: unknown): FindOptions {
  const input = record(value, "options");
  keys(input, ["path", "includeRoot", "maxDepth", "name", "pathGlob", "type", "cursor", "limit"], "options");
  const type = optionalString(input.type, "options.type");
  if (type !== undefined && type !== "file" && type !== "directory") {
    throw new VfsError("EINVAL", "options.type must be file or directory");
  }
  return {
    path: rpcString(input.path, "options.path"),
    ...(optionalBoolean(input.includeRoot, "options.includeRoot") === undefined
      ? {}
      : { includeRoot: input.includeRoot as boolean }),
    ...(optionalInteger(input.maxDepth, "options.maxDepth") === undefined
      ? {}
      : { maxDepth: input.maxDepth as number }),
    ...(optionalString(input.name, "options.name") === undefined ? {} : { name: input.name as string }),
    ...(optionalString(input.pathGlob, "options.pathGlob") === undefined
      ? {}
      : { pathGlob: input.pathGlob as string }),
    ...(type === undefined ? {} : { type }),
    ...rpcPageOptions({ cursor: input.cursor, limit: input.limit }),
  };
}

export function rpcWriteOptions(value: unknown): WriteFileOptions | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "options");
  keys(input, ["createParents", "disposition", "ifRevision", "ifMutationToken", "mode"], "options");
  const disposition = optionalString(input.disposition, "options.disposition");
  if (disposition !== undefined && !["create", "replace", "upsert"].includes(disposition)) {
    throw new VfsError("EINVAL", "options.disposition is invalid");
  }
  const createParents = optionalBoolean(input.createParents, "options.createParents");
  const mode = optionalInteger(input.mode, "options.mode");
  return {
    ...guardOptions(input),
    ...(createParents === undefined ? {} : { createParents }),
    ...(disposition === undefined
      ? {}
      : { disposition: disposition as Exclude<WriteFileOptions["disposition"], undefined> }),
    ...(mode === undefined ? {} : { mode }),
  };
}

export function rpcAppendOptions(value: unknown): AppendFileOptions | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "options");
  keys(input, ["ifRevision", "ifMutationToken"], "options");
  return guardOptions(input);
}

export function rpcMetadataOptions(value: unknown): MetadataUpdateOptions {
  const input = record(value, "options");
  keys(input, ["ifRevision", "ifMutationToken", "mode", "modifiedAtMs"], "options");
  const mode = optionalInteger(input.mode, "options.mode");
  const modifiedAtMs = optionalInteger(input.modifiedAtMs, "options.modifiedAtMs");
  return {
    ...guardOptions(input),
    ...(mode === undefined ? {} : { mode }),
    ...(modifiedAtMs === undefined ? {} : { modifiedAtMs }),
  };
}

export function rpcTouchOptions(value: unknown): TouchOptions | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "options");
  keys(input, ["ifRevision", "ifMutationToken", "mode", "modifiedAtMs", "create", "createParents"], "options");
  const create = optionalBoolean(input.create, "options.create");
  const createParents = optionalBoolean(input.createParents, "options.createParents");
  return {
    ...rpcMetadataOptions({
      ifRevision: input.ifRevision,
      ifMutationToken: input.ifMutationToken,
      mode: input.mode,
      modifiedAtMs: input.modifiedAtMs,
    }),
    ...(create === undefined ? {} : { create }),
    ...(createParents === undefined ? {} : { createParents }),
  };
}

export function rpcRemoveOptions(value: unknown): RemoveOptions | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "options");
  keys(input, ["recursive"], "options");
  const recursive = optionalBoolean(input.recursive, "options.recursive");
  return recursive === undefined ? {} : { recursive };
}

export function rpcMoveOptions(value: unknown): MoveOptions | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "options");
  keys(input, ["replace"], "options");
  const replace = optionalBoolean(input.replace, "options.replace");
  return replace === undefined ? {} : { replace };
}

export function rpcCopyOptions(value: unknown): CopyOptions | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "options");
  keys(input, ["replace", "recursive", "createParents"], "options");
  const replace = optionalBoolean(input.replace, "options.replace");
  const recursive = optionalBoolean(input.recursive, "options.recursive");
  const createParents = optionalBoolean(input.createParents, "options.createParents");
  return {
    ...(replace === undefined ? {} : { replace }),
    ...(recursive === undefined ? {} : { recursive }),
    ...(createParents === undefined ? {} : { createParents }),
  };
}

export function rpcBeginUploadOptions(value: unknown): BeginOpaqueUploadOptions | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "options");
  keys(input, ["createParents", "ifMutationToken", "mode", "expectedSizeBytes", "expiresInMs", "contentType"], "options");
  const createParents = optionalBoolean(input.createParents, "options.createParents");
  const ifMutationToken = optionalString(input.ifMutationToken, "options.ifMutationToken");
  const mode = optionalInteger(input.mode, "options.mode");
  const expectedSizeBytes = optionalInteger(input.expectedSizeBytes, "options.expectedSizeBytes");
  const expiresInMs = rpcOptionalPositiveInteger(input.expiresInMs, "options.expiresInMs");
  const contentType = optionalString(input.contentType, "options.contentType");
  return {
    ...(createParents === undefined ? {} : { createParents }),
    ...(ifMutationToken === undefined ? {} : { ifMutationToken }),
    ...(mode === undefined ? {} : { mode }),
    ...(expectedSizeBytes === undefined ? {} : { expectedSizeBytes }),
    ...(expiresInMs === undefined ? {} : { expiresInMs }),
    ...(contentType === undefined ? {} : { contentType }),
  };
}

export function rpcCommitUploadOptions(value: unknown): CommitOpaqueUploadOptions | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "options");
  keys(input, ["verifiedSha256"], "options");
  const verifiedSha256 = optionalString(input.verifiedSha256, "options.verifiedSha256");
  return verifiedSha256 === undefined ? {} : { verifiedSha256 };
}

import { VfsError } from "../core/errors.js";
import type {
  AppendFileOptions,
  BeginOpaqueUploadOptions,
  ByteBody,
  ChangesSinceOptions,
  CommitOpaqueUploadOptions,
  CopyOptions,
  EntryKind,
  FindOptions,
  MetadataUpdateOptions,
  MoveOptions,
  OwnershipUpdateOptions,
  PageOptions,
  PosixCredentials,
  RemoveOptions,
  SymlinkOptions,
  TouchOptions,
  WriteDisposition,
  WriteFileOptions,
  WriteFilesEntry,
  WriteFilesOptions,
} from "./types.js";

const MAX_POSIX_ID = 0xffff_ffff;

type UnknownRecord = Readonly<Record<string, unknown>>;

const ENTRY_KINDS = {
  directory: true,
  file: true,
  symlink: true,
} as const satisfies Readonly<Record<EntryKind, true>>;

const WRITE_DISPOSITIONS = {
  create: true,
  replace: true,
  upsert: true,
} as const satisfies Readonly<Record<WriteDisposition, true>>;

export function rpcRecord(value: unknown, name: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new VfsError("EINVAL", `${name} must be an object`);
  }
  // JavaScript has no indexable-object narrowing. Callers still receive
  // unknown at every property and must parse each one before using it.
  return value as UnknownRecord;
}

function keys(value: UnknownRecord, allowed: readonly string[], name: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new VfsError("EINVAL", `${name}.${extra} is not supported`);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function rpcString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new VfsError("EINVAL", `${name} must be a string`);
  return value;
}

export function rpcOptionalStringArray(
  value: unknown,
  name: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new VfsError("EINVAL", `${name} must be an array of strings`);
  const parsed: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new VfsError("EINVAL", `${name} must be an array of strings`);
    }
    parsed.push(item);
  }
  return parsed;
}

export function rpcOptionalStringRecord(
  value: unknown,
  name: string,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new VfsError("EINVAL", `${name} must be a string record`);
  }
  const input = rpcRecord(value, name);
  const parsed: [string, string][] = [];
  for (const [key, item] of Object.entries(input)) {
    if (typeof item !== "string") {
      throw new VfsError("EINVAL", `${name} values must be strings`);
    }
    parsed.push([key, item]);
  }
  return Object.fromEntries(parsed);
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
  if (!isSafeInteger(value) || value < minimum) {
    throw new VfsError("EINVAL", `${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function optionalLiteral<const Literals extends Readonly<Record<string, true>>>(
  value: unknown,
  literals: Literals,
  error: string,
): Extract<keyof Literals, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    for (const literal in literals) {
      if (literal === value) return literal;
    }
  }
  throw new VfsError("EINVAL", error);
}

/**
 * An entry identity arriving over RPC.
 *
 * Zero is the documented sentinel for a path with no entry, so it is refused
 * here rather than reaching the namespace and coming back as `ENOENT`, which
 * would read as "that entry is gone" for something that never was one.
 */
export function rpcIdentity(value: unknown): number {
  if (!isSafeInteger(value) || value < 1) {
    throw new VfsError("EINVAL", "ino must be a positive safe integer");
  }
  return value;
}

export function rpcOptionalPositiveInteger(value: unknown, name: string): number | undefined {
  return optionalInteger(value, name, 1);
}

export function rpcOptionalNonnegativeInteger(value: unknown, name: string): number | undefined {
  return optionalInteger(value, name);
}

function posixId(value: unknown, name: string): number {
  if (!isSafeInteger(value) || value < 0 || value > MAX_POSIX_ID) {
    throw new VfsError("EINVAL", `${name} must be an integer between 0 and ${MAX_POSIX_ID}`);
  }
  return value;
}

function optionalPosixId(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : posixId(value, name);
}

export function rpcPosixCredentials(value: unknown, name: string): PosixCredentials | undefined {
  if (value === undefined) return undefined;
  const input = rpcRecord(value, name);
  keys(input, ["uid", "gid", "supplementaryGids"], name);
  const uid = optionalPosixId(input["uid"], `${name}.uid`);
  const gid = optionalPosixId(input["gid"], `${name}.gid`);
  if (uid === undefined || gid === undefined) {
    throw new VfsError("EINVAL", `${name} requires uid and gid`);
  }
  const supplementary = input["supplementaryGids"];
  if (supplementary !== undefined && !Array.isArray(supplementary)) {
    throw new VfsError("EINVAL", `${name}.supplementaryGids must be an array`);
  }
  return {
    uid,
    gid,
    ...(supplementary === undefined
      ? {}
      : {
          supplementaryGids: supplementary.map((entry) =>
            posixId(entry, `${name}.supplementaryGids`),
          ),
        }),
  };
}

function guardOptions(input: UnknownRecord): { ifMutationToken?: string } {
  const ifMutationToken = optionalString(input["ifMutationToken"], "options.ifMutationToken");
  return ifMutationToken === undefined ? {} : { ifMutationToken };
}

export function rpcByteBody(value: unknown, name = "body"): ByteBody {
  if (
    typeof value === "string" ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof ReadableStream
  )
    return value;
  throw new VfsError("EINVAL", `${name} must be bytes, text, or a byte stream`);
}

export function rpcPageOptions(value: unknown): PageOptions | undefined {
  if (value === undefined) return undefined;
  const input = rpcRecord(value, "options");
  keys(input, ["cursor", "limit"], "options");
  const cursor = optionalString(input["cursor"], "options.cursor");
  const limit = rpcOptionalPositiveInteger(input["limit"], "options.limit");
  return { ...(cursor === undefined ? {} : { cursor }), ...(limit === undefined ? {} : { limit }) };
}

export function rpcNonnegativeInteger(value: unknown, name: string): number {
  if (!isSafeInteger(value) || value < 0) {
    throw new VfsError("EINVAL", `${name} must be a safe integer >= 0`);
  }
  return value;
}

export function rpcChangesSinceOptions(value: unknown): ChangesSinceOptions | undefined {
  if (value === undefined) return undefined;
  const input = rpcRecord(value, "options");
  keys(input, ["limit"], "options");
  const limit = rpcOptionalPositiveInteger(input["limit"], "options.limit");
  return limit === undefined ? {} : { limit };
}

export function rpcFindOptions(value: unknown): FindOptions {
  const input = rpcRecord(value, "options");
  keys(
    input,
    ["path", "includeRoot", "maxDepth", "name", "pathGlob", "type", "cursor", "limit"],
    "options",
  );
  const includeRoot = optionalBoolean(input["includeRoot"], "options.includeRoot");
  const maxDepth = optionalInteger(input["maxDepth"], "options.maxDepth");
  const name = optionalString(input["name"], "options.name");
  const pathGlob = optionalString(input["pathGlob"], "options.pathGlob");
  const type = optionalLiteral(
    input["type"],
    ENTRY_KINDS,
    "options.type must be file, directory, or symlink",
  );
  return {
    path: rpcString(input["path"], "options.path"),
    ...(includeRoot === undefined ? {} : { includeRoot }),
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...(name === undefined ? {} : { name }),
    ...(pathGlob === undefined ? {} : { pathGlob }),
    ...(type === undefined ? {} : { type }),
    ...rpcPageOptions({ cursor: input["cursor"], limit: input["limit"] }),
  };
}

export function rpcWriteOptions(value: unknown): WriteFileOptions | undefined {
  if (value === undefined) return undefined;
  const input = rpcRecord(value, "options");
  keys(
    input,
    ["createParents", "disposition", "ifMutationToken", "mode", "skipIfUnchanged"],
    "options",
  );
  const disposition = optionalLiteral(
    input["disposition"],
    WRITE_DISPOSITIONS,
    "options.disposition is invalid",
  );
  const createParents = optionalBoolean(input["createParents"], "options.createParents");
  const mode = optionalInteger(input["mode"], "options.mode");
  const skipIfUnchanged = optionalBoolean(input["skipIfUnchanged"], "options.skipIfUnchanged");
  return {
    ...guardOptions(input),
    ...(createParents === undefined ? {} : { createParents }),
    ...(disposition === undefined ? {} : { disposition }),
    ...(mode === undefined ? {} : { mode }),
    ...(skipIfUnchanged === undefined ? {} : { skipIfUnchanged }),
  };
}

/**
 * A batch's entries arriving over RPC.
 *
 * Validated entry by entry and named by index, because a batch that is refused
 * for its ninth entry has to say which one -- the caller is holding a set, and
 * "one of these is wrong" is not something it can act on.
 */
export function rpcWriteFilesEntries(value: unknown): WriteFilesEntry[] {
  if (!Array.isArray(value)) throw new VfsError("EINVAL", "entries must be an array");
  return value.map((entry, index) => {
    const name = `entries[${index}]`;
    const input = rpcRecord(entry, name);
    keys(input, ["path", "body", "ifMutationToken", "mode"], name);
    const ifMutationToken = optionalString(input["ifMutationToken"], `${name}.ifMutationToken`);
    const mode = optionalInteger(input["mode"], `${name}.mode`);
    return {
      path: rpcString(input["path"], `${name}.path`),
      body: rpcByteBody(input["body"], `${name}.body`),
      ...(ifMutationToken === undefined ? {} : { ifMutationToken }),
      ...(mode === undefined ? {} : { mode }),
    };
  });
}

export function rpcWriteFilesOptions(value: unknown): WriteFilesOptions | undefined {
  if (value === undefined) return undefined;
  const input = rpcRecord(value, "options");
  keys(input, ["createParents", "disposition", "skipIfUnchanged"], "options");
  const disposition = optionalLiteral(
    input["disposition"],
    WRITE_DISPOSITIONS,
    "options.disposition is invalid",
  );
  const createParents = optionalBoolean(input["createParents"], "options.createParents");
  const skipIfUnchanged = optionalBoolean(input["skipIfUnchanged"], "options.skipIfUnchanged");
  return {
    ...(createParents === undefined ? {} : { createParents }),
    ...(disposition === undefined ? {} : { disposition }),
    ...(skipIfUnchanged === undefined ? {} : { skipIfUnchanged }),
  };
}

export function rpcAppendOptions(value: unknown): AppendFileOptions | undefined {
  if (value === undefined) return undefined;
  const input = rpcRecord(value, "options");
  keys(input, ["ifMutationToken"], "options");
  return guardOptions(input);
}

export function rpcMetadataOptions(value: unknown): MetadataUpdateOptions {
  const input = rpcRecord(value, "options");
  keys(input, ["ifMutationToken", "mode", "modifiedAtMs"], "options");
  const mode = optionalInteger(input["mode"], "options.mode");
  const modifiedAtMs = optionalInteger(input["modifiedAtMs"], "options.modifiedAtMs");
  return {
    ...guardOptions(input),
    ...(mode === undefined ? {} : { mode }),
    ...(modifiedAtMs === undefined ? {} : { modifiedAtMs }),
  };
}

export function rpcOwnershipOptions(value: unknown): OwnershipUpdateOptions {
  const input = rpcRecord(value, "options");
  keys(input, ["ifMutationToken", "uid", "gid"], "options");
  const uid = optionalPosixId(input["uid"], "options.uid");
  const gid = optionalPosixId(input["gid"], "options.gid");
  if (uid === undefined && gid === undefined) {
    throw new VfsError("EINVAL", "options.uid or options.gid is required");
  }
  return {
    ...guardOptions(input),
    ...(uid === undefined ? {} : { uid }),
    ...(gid === undefined ? {} : { gid }),
  };
}

export function rpcSymlinkOptions(value: unknown): SymlinkOptions | undefined {
  if (value === undefined) return undefined;
  const input = rpcRecord(value, "options");
  keys(input, ["createParents", "ifMutationToken", "replace"], "options");
  const createParents = optionalBoolean(input["createParents"], "options.createParents");
  const replace = optionalBoolean(input["replace"], "options.replace");
  const ifMutationToken = optionalString(input["ifMutationToken"], "options.ifMutationToken");
  return {
    ...(ifMutationToken === undefined ? {} : { ifMutationToken }),
    ...(createParents === undefined ? {} : { createParents }),
    ...(replace === undefined ? {} : { replace }),
  };
}

export function rpcFollowOptions(value: unknown): { follow?: boolean } | undefined {
  if (value === undefined) return undefined;
  const input = rpcRecord(value, "options");
  keys(input, ["follow"], "options");
  const follow = optionalBoolean(input["follow"], "options.follow");
  return follow === undefined ? {} : { follow };
}

export function rpcTouchOptions(value: unknown): TouchOptions | undefined {
  if (value === undefined) return undefined;
  const input = rpcRecord(value, "options");
  keys(input, ["ifMutationToken", "mode", "modifiedAtMs", "create", "createParents"], "options");
  const create = optionalBoolean(input["create"], "options.create");
  const createParents = optionalBoolean(input["createParents"], "options.createParents");
  return {
    ...rpcMetadataOptions({
      ifMutationToken: input["ifMutationToken"],
      mode: input["mode"],
      modifiedAtMs: input["modifiedAtMs"],
    }),
    ...(create === undefined ? {} : { create }),
    ...(createParents === undefined ? {} : { createParents }),
  };
}

export function rpcRemoveOptions(value: unknown): RemoveOptions | undefined {
  if (value === undefined) return undefined;
  const input = rpcRecord(value, "options");
  keys(input, ["recursive"], "options");
  const recursive = optionalBoolean(input["recursive"], "options.recursive");
  return recursive === undefined ? {} : { recursive };
}

export function rpcMoveOptions(value: unknown): MoveOptions | undefined {
  if (value === undefined) return undefined;
  const input = rpcRecord(value, "options");
  keys(input, ["replace"], "options");
  const replace = optionalBoolean(input["replace"], "options.replace");
  return replace === undefined ? {} : { replace };
}

export function rpcCopyOptions(value: unknown): CopyOptions | undefined {
  if (value === undefined) return undefined;
  const input = rpcRecord(value, "options");
  keys(input, ["replace", "recursive", "createParents", "dereference"], "options");
  const replace = optionalBoolean(input["replace"], "options.replace");
  const recursive = optionalBoolean(input["recursive"], "options.recursive");
  const createParents = optionalBoolean(input["createParents"], "options.createParents");
  const dereference = optionalBoolean(input["dereference"], "options.dereference");
  return {
    ...(replace === undefined ? {} : { replace }),
    ...(recursive === undefined ? {} : { recursive }),
    ...(createParents === undefined ? {} : { createParents }),
    ...(dereference === undefined ? {} : { dereference }),
  };
}

export function rpcBeginUploadOptions(value: unknown): BeginOpaqueUploadOptions | undefined {
  if (value === undefined) return undefined;
  const input = rpcRecord(value, "options");
  keys(
    input,
    ["createParents", "ifMutationToken", "mode", "expectedSizeBytes", "expiresInMs", "contentType"],
    "options",
  );
  const createParents = optionalBoolean(input["createParents"], "options.createParents");
  const ifMutationToken = optionalString(input["ifMutationToken"], "options.ifMutationToken");
  const mode = optionalInteger(input["mode"], "options.mode");
  const expectedSizeBytes = optionalInteger(
    input["expectedSizeBytes"],
    "options.expectedSizeBytes",
  );
  const expiresInMs = rpcOptionalPositiveInteger(input["expiresInMs"], "options.expiresInMs");
  const contentType = optionalString(input["contentType"], "options.contentType");
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
  const input = rpcRecord(value, "options");
  keys(input, ["verifiedSha256"], "options");
  const verifiedSha256 = optionalString(input["verifiedSha256"], "options.verifiedSha256");
  return verifiedSha256 === undefined ? {} : { verifiedSha256 };
}

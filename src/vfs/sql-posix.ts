import { VfsError } from "../core/errors.js";
import type { PosixCredentials, PosixViewOptions } from "./types.js";

const MAX_POSIX_ID = 0xffff_ffff;
const DEFAULT_UMASK = 0o022;

export const READ_PERMISSION = 0o4;
export const WRITE_PERMISSION = 0o2;
export const EXECUTE_PERMISSION = 0o1;
export const SETGID_BIT = 0o2000;
export const STICKY_BIT = 0o1000;

export interface PosixAccessContext {
  readonly credentials: Readonly<Required<PosixCredentials>>;
  readonly groups: ReadonlySet<number>;
  readonly umask: number;
}

export type PosixMutationOperation =
  | { readonly kind: "copy"; readonly dereference: boolean }
  | { readonly kind: "move" }
  | { readonly kind: "remove-recursive" };

export function posixId(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_POSIX_ID) {
    throw new VfsError("EINVAL", `${name} must be an integer between 0 and ${MAX_POSIX_ID}`);
  }
  return value;
}

export function posixContext(
  credentials: PosixCredentials,
  options: PosixViewOptions = {},
): PosixAccessContext {
  const uid = posixId(credentials.uid, "credentials.uid");
  const gid = posixId(credentials.gid, "credentials.gid");
  const supplementaryGids = [...new Set(credentials.supplementaryGids ?? [])].map((value) =>
    posixId(value, "credentials.supplementaryGids"),
  );
  const umask = options.umask ?? DEFAULT_UMASK;
  if (!Number.isSafeInteger(umask) || umask < 0 || umask > 0o777) {
    throw new VfsError("EINVAL", "umask must be an integer between 000 and 777");
  }
  return Object.freeze({
    credentials: Object.freeze({
      uid,
      gid,
      supplementaryGids: Object.freeze(supplementaryGids),
    }),
    groups: new Set([gid, ...supplementaryGids]),
    umask,
  });
}

interface StatBaseForPermissions {
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

export function posixPermissions(
  entry: Pick<StatBaseForPermissions, "uid" | "gid" | "mode">,
  access: PosixAccessContext,
): number {
  if (access.credentials.uid === 0) return 0o7;
  if (entry.uid === access.credentials.uid) return (entry.mode >> 6) & 0o7;
  if (access.groups.has(entry.gid)) return (entry.mode >> 3) & 0o7;
  return entry.mode & 0o7;
}

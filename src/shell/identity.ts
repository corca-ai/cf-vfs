import { isVfsError, VfsError } from "../core/errors.js";

const MAX_ID = 0xffff_ffff;
const MAX_IDENTITY_NAME_BYTES = 255;
const INVALID_IDENTITY_NAME = /[\p{C}\p{Z}:/]/u;

export interface IdentityIds {
  readonly uids: readonly number[];
  readonly gids: readonly number[];
}

export interface IdentityNames {
  readonly users: readonly string[];
  readonly groups: readonly string[];
}

export interface ResolvedIdentityNames {
  readonly users: ReadonlyMap<number, string>;
  readonly groups: ReadonlyMap<number, string>;
}

export interface ResolvedIdentityIds {
  readonly users: ReadonlyMap<string, number>;
  readonly groups: ReadonlyMap<string, number>;
}

/**
 * Resolves the host's account names without participating in authorization.
 *
 * Both directions are bulk operations so a directory listing or ownership
 * change never needs one host call per entry. Partial results are valid. A
 * returned or requested name must be 1-255 UTF-8 bytes and contain no control,
 * separator, colon, or slash character.
 */
export interface ShellIdentityResolver {
  resolveIds(
    identities: IdentityIds,
    signal: AbortSignal,
  ): ResolvedIdentityNames | PromiseLike<ResolvedIdentityNames>;
  resolveNames(
    identities: IdentityNames,
    signal: AbortSignal,
  ): ResolvedIdentityIds | PromiseLike<ResolvedIdentityIds>;
}

/**
 * The narrow resolver capability visible to commands in one execution.
 *
 * The helpers below cache against this object. Keeping cache construction out
 * of the shell core means a bundle with no identity-aware applet carries none
 * of the lookup implementation.
 */
export interface ShellIdentitySource {
  readonly resolver: ShellIdentityResolver;
  readonly signal: AbortSignal;
}

function validIdentityName(value: string): boolean {
  return (
    value.length > 0 &&
    !INVALID_IDENTITY_NAME.test(value) &&
    new TextEncoder().encode(value).byteLength <= MAX_IDENTITY_NAME_BYTES
  );
}

function resolverFailure(error: unknown): never {
  if (isVfsError(error)) throw error;
  throw new VfsError(
    "EIO",
    error instanceof Error
      ? `identity resolver failed: ${error.message}`
      : "identity resolver failed",
  );
}

interface PendingIdentityCache {
  pending: Promise<void> | undefined;
}

async function populateCache<Result>(
  cache: PendingIdentityCache,
  resolve: () => Result | PromiseLike<Result>,
  populate: (result: Result) => void,
): Promise<void> {
  const pending = Promise.resolve().then(resolve).then(populate).catch(resolverFailure);
  cache.pending = pending;
  try {
    await pending;
  } finally {
    if (cache.pending === pending) cache.pending = undefined;
  }
}

function resolvedName(
  result: ResolvedIdentityNames,
  section: "users" | "groups",
  id: number,
): string | undefined {
  const value: unknown = result[section].get(id);
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !validIdentityName(value)) {
    throw new VfsError("EIO", "identity resolver returned an invalid account name");
  }
  return value;
}

interface NameCache {
  readonly users: Map<number, string | undefined>;
  readonly groups: Map<number, string | undefined>;
  pending: Promise<void> | undefined;
}

const NAME_CACHES = /* @__PURE__ */ new WeakMap<ShellIdentitySource, NameCache>();

function nameCache(source: ShellIdentitySource): NameCache {
  const existing = NAME_CACHES.get(source);
  if (existing !== undefined) return existing;
  const created: NameCache = { users: new Map(), groups: new Map(), pending: undefined };
  NAME_CACHES.set(source, created);
  return created;
}

export async function resolveIdentityNames(
  source: ShellIdentitySource,
  requestedUids: readonly number[],
  requestedGids: readonly number[],
): Promise<ResolvedIdentityNames> {
  const uids = [...new Set(requestedUids)];
  const gids = [...new Set(requestedGids)];
  const cache = nameCache(source);
  if (cache.pending !== undefined) await cache.pending;
  const missingUids = uids.filter((id) => !cache.users.has(id));
  const missingGids = gids.filter((id) => !cache.groups.has(id));
  if (missingUids.length > 0 || missingGids.length > 0) {
    await populateCache(
      cache,
      () => source.resolver.resolveIds({ uids: missingUids, gids: missingGids }, source.signal),
      (result) => {
        for (const id of missingUids) cache.users.set(id, resolvedName(result, "users", id));
        for (const id of missingGids) cache.groups.set(id, resolvedName(result, "groups", id));
      },
    );
  }
  const users = new Map<number, string>();
  const groups = new Map<number, string>();
  for (const id of uids) {
    const name = cache.users.get(id);
    if (name !== undefined) users.set(id, name);
  }
  for (const id of gids) {
    const name = cache.groups.get(id);
    if (name !== undefined) groups.set(id, name);
  }
  return { users, groups };
}
function uniqueNames(values: readonly string[]): string[] {
  const unique = [...new Set(values)];
  if (unique.some((value) => !validIdentityName(value))) {
    throw new VfsError("EINVAL", "invalid user or group name");
  }
  return unique;
}

function resolvedId(
  result: ResolvedIdentityIds,
  section: "users" | "groups",
  name: string,
): number | undefined {
  const value: unknown = result[section].get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_ID) {
    throw new VfsError("EIO", "identity resolver returned an invalid account ID");
  }
  return value;
}

interface IdCache {
  readonly users: Map<string, number | undefined>;
  readonly groups: Map<string, number | undefined>;
  pending: Promise<void> | undefined;
}

const ID_CACHES = /* @__PURE__ */ new WeakMap<ShellIdentitySource, IdCache>();

function idCache(source: ShellIdentitySource): IdCache {
  const existing = ID_CACHES.get(source);
  if (existing !== undefined) return existing;
  const created: IdCache = { users: new Map(), groups: new Map(), pending: undefined };
  ID_CACHES.set(source, created);
  return created;
}

export async function resolveIdentityIds(
  source: ShellIdentitySource,
  requestedUsers: readonly string[],
  requestedGroups: readonly string[],
): Promise<ResolvedIdentityIds> {
  const users = uniqueNames(requestedUsers);
  const groups = uniqueNames(requestedGroups);
  const cache = idCache(source);
  if (cache.pending !== undefined) await cache.pending;
  const missingUsers = users.filter((name) => !cache.users.has(name));
  const missingGroups = groups.filter((name) => !cache.groups.has(name));
  if (missingUsers.length > 0 || missingGroups.length > 0) {
    await populateCache(
      cache,
      () =>
        source.resolver.resolveNames({ users: missingUsers, groups: missingGroups }, source.signal),
      (result) => {
        for (const name of missingUsers) cache.users.set(name, resolvedId(result, "users", name));
        for (const name of missingGroups)
          cache.groups.set(name, resolvedId(result, "groups", name));
      },
    );
  }
  const resolvedUsers = new Map<string, number>();
  const resolvedGroups = new Map<string, number>();
  for (const name of users) {
    const id = cache.users.get(name);
    if (id !== undefined) resolvedUsers.set(name, id);
  }
  for (const name of groups) {
    const id = cache.groups.get(name);
    if (id !== undefined) resolvedGroups.set(name, id);
  }
  return { users: resolvedUsers, groups: resolvedGroups };
}

export function identityLabel(values: ReadonlyMap<number, string> | undefined, id: number): string {
  return values?.get(id) ?? String(id);
}

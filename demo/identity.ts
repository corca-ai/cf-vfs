import type {
  IdentityIds,
  IdentityNames,
  ResolvedIdentityIds,
  ResolvedIdentityNames,
  ShellIdentityResolver,
} from "../src/shell/identity.js";
import type { PosixCredentials, VfsStat, VirtualFileSystem } from "../src/vfs/types.js";

export const DEMO_USER = "demo";
export const DEMO_GROUP = "demo";
export const DEMO_UID = 1_000;
export const DEMO_GID = 1_000;

export const DEMO_CREDENTIALS = Object.freeze({
  uid: DEMO_UID,
  gid: DEMO_GID,
  supplementaryGids: Object.freeze([]),
}) satisfies PosixCredentials;

const USERS_BY_ID = new Map([
  [0, "root"],
  [DEMO_UID, DEMO_USER],
]);
const GROUPS_BY_ID = new Map([
  [0, "root"],
  [DEMO_GID, DEMO_GROUP],
]);
const USERS_BY_NAME = new Map([...USERS_BY_ID].map(([id, name]) => [name, id]));
const GROUPS_BY_NAME = new Map([...GROUPS_BY_ID].map(([id, name]) => [name, id]));

function select<Key, Value>(
  requested: readonly Key[],
  directory: ReadonlyMap<Key, Value>,
): Map<Key, Value> {
  const resolved = new Map<Key, Value>();
  for (const key of requested) {
    const value = directory.get(key);
    if (value !== undefined) resolved.set(key, value);
  }
  return resolved;
}

/**
 * The demo host's account directory.
 *
 * It is deliberately outside the VFS. The shell receives only this lookup
 * capability, while filesystem authorization receives numeric credentials.
 */
export const DEMO_IDENTITY_RESOLVER: ShellIdentityResolver = Object.freeze({
  resolveIds({ uids, gids }: IdentityIds): ResolvedIdentityNames {
    return {
      users: select(uids, USERS_BY_ID),
      groups: select(gids, GROUPS_BY_ID),
    };
  },
  resolveNames({ users, groups }: IdentityNames): ResolvedIdentityIds {
    return {
      users: select(users, USERS_BY_NAME),
      groups: select(groups, GROUPS_BY_NAME),
    };
  },
});

type OwnershipFileSystem = Pick<VirtualFileSystem, "find" | "setOwnership">;

export function ensureDemoOwnership(
  fileSystem: Pick<VirtualFileSystem, "setOwnership">,
  entries: readonly VfsStat[],
): number {
  let changed = 0;
  for (const entry of entries) {
    if (
      entry.kind === "symlink" ||
      (entry.uid === DEMO_CREDENTIALS.uid && entry.gid === DEMO_CREDENTIALS.gid)
    ) {
      continue;
    }
    fileSystem.setOwnership(entry.path, {
      uid: DEMO_CREDENTIALS.uid,
      gid: DEMO_CREDENTIALS.gid,
    });
    changed += 1;
  }
  return changed;
}

/**
 * Gives the demo account ownership of a workspace created by older versions.
 *
 * Symbolic links are skipped because `setOwnership()` follows the terminal
 * link. Their ownership does not control removal; the containing directory
 * does, and every real directory is migrated here.
 */
export function migrateDemoOwnership(fileSystem: OwnershipFileSystem): number {
  return ensureDemoOwnership(fileSystem, fileSystem.find({ path: "/", includeRoot: true }));
}

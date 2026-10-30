import { awikiCommand } from "../src/shell/commands/awiki.js";
import { awkCommand } from "../src/shell/commands/awk.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { gitCommand } from "../src/shell/commands/git.js";
import type { ShellEvent } from "../src/shell/events.js";
import type {
  IdentityIds,
  IdentityNames,
  ResolvedIdentityIds,
  ResolvedIdentityNames,
  ShellIdentityResolver,
} from "../src/shell/identity.js";
import { InteractiveShell } from "../src/shell/interactive.js";
import {
  LINUX_SHELL_OPTIONS,
  LINUX_WORKSPACE,
  linuxShellEnvironment,
  provisionLinuxFilesystem,
} from "../src/shell/linux.js";
import type { SqlFileSystem } from "../src/vfs/sql.js";
import type { PosixCredentials } from "../src/vfs/types.js";

/**
 * The machine an evaluated agent sees, shared by the Durable Object and the
 * local log replay so both run the same shell over the same layout.
 */

/**
 * The account an agent runs as. Ordinary names on purpose: nothing an agent
 * can observe should announce an evaluation harness.
 */
const EVAL_USER = "user";
const EVAL_UID = 1_000;
const EVAL_GID = 1_000;
const EVAL_HOME = `/home/${EVAL_USER}`;
const EVAL_CREDENTIALS = Object.freeze({
  uid: EVAL_UID,
  gid: EVAL_GID,
  supplementaryGids: Object.freeze([]),
}) satisfies PosixCredentials;
const EVAL_UMASK = 0o022;
const EVAL_COMMANDS = [...defaultShellCommands, awkCommand, gitCommand, awikiCommand];

const USERS_BY_ID = new Map([
  [0, "root"],
  [EVAL_UID, EVAL_USER],
]);
const GROUPS_BY_ID = new Map([
  [0, "root"],
  [EVAL_GID, EVAL_USER],
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

const EVAL_IDENTITY_RESOLVER: ShellIdentityResolver = Object.freeze({
  resolveIds({ uids, gids }: IdentityIds): ResolvedIdentityNames {
    return { users: select(uids, USERS_BY_ID), groups: select(gids, GROUPS_BY_ID) };
  },
  resolveNames({ users, groups }: IdentityNames): ResolvedIdentityIds {
    return { users: select(users, USERS_BY_NAME), groups: select(groups, GROUPS_BY_NAME) };
  },
});

export interface SeedFile {
  readonly path: string;
  readonly content: string;
}

/** Creates the Linux layout, owned by the agent's account where it works. */
export function provisionEvalWorkspace(fileSystem: SqlFileSystem): void {
  const profile = provisionLinuxFilesystem(fileSystem, { user: EVAL_USER });
  for (const entry of profile) {
    if (entry.path === EVAL_HOME || entry.path === LINUX_WORKSPACE) {
      fileSystem.setOwnership(entry.path, { uid: EVAL_UID, gid: EVAL_GID });
    }
  }
  for (const path of ["/tmp", "/var/tmp"]) fileSystem.setMetadata(path, { mode: 0o1777 });
}

/**
 * Writes fixture files as the agent's account, creating parents, in one
 * atomic batch. Relative paths are relative to the workspace directory.
 */
export async function seedEvalWorkspace(
  fileSystem: SqlFileSystem,
  files: readonly SeedFile[],
): Promise<void> {
  const view = fileSystem.forCredentials(EVAL_CREDENTIALS, { umask: EVAL_UMASK });
  await view.writeFiles(
    files.map((file) => ({
      path: file.path.startsWith("/") ? file.path : `${LINUX_WORKSPACE}/${file.path}`,
      body: file.content,
    })),
    { createParents: true },
  );
}

export interface EvalShellOptions {
  readonly onEvent?: (event: ShellEvent) => void;
  /** The replay pins the clock to each logged execution's time. */
  readonly now?: () => number;
}

/** A fresh shell for one execution; only the working directory carries over. */
export function evalShell(
  fileSystem: SqlFileSystem,
  cwd: string,
  { onEvent, now }: EvalShellOptions = {},
): InteractiveShell {
  return new InteractiveShell({
    fileSystem,
    commands: EVAL_COMMANDS,
    ...LINUX_SHELL_OPTIONS,
    cwd,
    env: linuxShellEnvironment({ user: EVAL_USER }),
    credentials: EVAL_CREDENTIALS,
    umask: EVAL_UMASK,
    identityResolver: EVAL_IDENTITY_RESOLVER,
    ...(onEvent === undefined ? {} : { onEvent }),
    ...(now === undefined ? {} : { now }),
  });
}

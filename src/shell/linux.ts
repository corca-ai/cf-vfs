import { normalizePath } from "../core/path.js";
import type { VfsStat, VirtualFileSystem } from "../vfs/types.js";
import { APPLET_DIRECTORIES } from "./commands/applet.js";

/**
 * An opt-in Linux-shaped environment for a `Shell`.
 *
 * This is a cf-vfs profile, not Linux and not the Filesystem Hierarchy
 * Standard. It supplies the small set of locations and variables that ordinary
 * scripts and file-working agents assume, and nothing else: there is no user
 * database, no package manager, no writable `/bin`, and no host process.
 *
 * Importing this module is how an application opts in. A `Shell` built without
 * it keeps the plain environment and resolves every registered applet by bare
 * name.
 */

/** Where the profile expects an application to keep working files. */
export const LINUX_WORKSPACE = "/workspace";

/**
 * Directories the profile creates in the namespace.
 *
 * These are ordinary directories because scripts write into them. `/bin` and
 * `/usr/bin` are deliberately absent: they resolve applets without a namespace
 * entry, so creating them would add rows that mean nothing and could be
 * removed while `/bin/cat` kept working.
 */
export const LINUX_DATA_DIRECTORIES: readonly string[] = [
  "/etc",
  "/home",
  "/tmp",
  "/var",
  "/var/tmp",
  LINUX_WORKSPACE,
];

/**
 * Directories that resolve applets virtually.
 *
 * Listing one of these is not supported: they exist for command resolution,
 * never as namespace entries.
 */
export const LINUX_APPLET_DIRECTORIES: readonly string[] = APPLET_DIRECTORIES;

/**
 * The canonical spelling of the cf-vfs shell profile.
 *
 * `SHELL` names it so a script can report which shell it is under. Executing
 * that path is not supported yet; a shell script becomes runnable with the
 * executable-file support tracked separately.
 */
export const LINUX_SHELL_PATH = "/bin/sh";

export interface LinuxProfileOptions {
  /** Account name reported by `USER` and `LOGNAME`. Defaults to `cf`. */
  readonly user?: string;
  /** Home directory. Defaults to `/home/<user>`. */
  readonly home?: string;
  /** Initial working directory. Defaults to the workspace. */
  readonly cwd?: string;
  /** Temporary directory reported by `TMPDIR`. Defaults to `/tmp`. */
  readonly tmp?: string;
}

const DEFAULT_USER = "cf";

function profile(options: LinuxProfileOptions): {
  user: string;
  home: string;
  cwd: string;
  tmp: string;
} {
  const user = options.user ?? DEFAULT_USER;
  const home = normalizePath(options.home ?? `/home/${user}`);
  return {
    user,
    home,
    cwd: normalizePath(options.cwd ?? LINUX_WORKSPACE),
    tmp: normalizePath(options.tmp ?? "/tmp"),
  };
}

/**
 * Environment defaults for the profile.
 *
 * `PATH` names the virtual applet directories, so command resolution searches
 * them left to right. `LC_ALL` and `TZ` repeat the runtime's fixed values
 * rather than offering a choice: the profile does not add locale support.
 */
export function linuxShellEnvironment(options: LinuxProfileOptions = {}): Record<string, string> {
  const { user, home, tmp } = profile(options);
  return {
    PATH: LINUX_APPLET_DIRECTORIES.join(":"),
    HOME: home,
    USER: user,
    LOGNAME: user,
    SHELL: LINUX_SHELL_PATH,
    TMPDIR: tmp,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
  };
}

/**
 * Creates the profile's data directories and returns them.
 *
 * `mkdir` is recursive here, so an existing directory is left alone and
 * provisioning is idempotent. It writes namespace rows only for directories a
 * script can write into, never for an applet directory, and never touches R2.
 */
export function provisionLinuxFilesystem(
  fileSystem: Pick<VirtualFileSystem, "mkdir">,
  options: LinuxProfileOptions = {},
): VfsStat[] {
  const { home, cwd } = profile(options);
  const created: VfsStat[] = [];
  for (const path of [...LINUX_DATA_DIRECTORIES, home, cwd]) {
    created.push(fileSystem.mkdir(path, true));
  }
  return created;
}

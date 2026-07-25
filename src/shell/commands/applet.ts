import { VfsError } from "../../core/errors.js";
import { compareUtf8 } from "../../core/path.js";
import type {
  ShellCommand,
  ShellCommandContext,
  ShellFileDescriptors,
  ShellProcess,
} from "../types.js";
import {
  type ParsedUtilityOptions,
  parseUtilityOptions,
  type UtilityOptionParserConfig,
} from "./options.js";

/**
 * Virtual directories whose entries resolve to a registered applet.
 *
 * Resolution is a literal directory-prefix match, not a namespace lookup: no
 * SQLite row, R2 object, or `PATH` search backs these spellings. A script that
 * writes a file at `/bin/cat` does not shadow the applet, and removing one
 * cannot break command resolution. The match is deliberately literal, so a
 * duplicated separator such as `/bin//cat` or `//bin/cat` does not resolve.
 */
export const APPLET_DIRECTORIES: readonly string[] = ["/bin", "/usr/bin"];

const SLASH = 47;

export type AppletRunner = (
  context: ShellCommandContext,
  argv: readonly string[],
  fds: ShellFileDescriptors,
) => Promise<number> | number;

/**
 * Declarative description of one applet.
 *
 * The specification is the single source of truth for the canonical name used
 * in diagnostics, the extra spellings that resolve to the same implementation,
 * the operand syntax reported by a usage error, and the option table the applet
 * scans. Nothing here imports a concrete applet, so shared code and the
 * individual applet modules stay independently importable.
 */
export interface AppletSpec<Name extends string = string> {
  /** Canonical name. Every diagnostic uses this spelling. */
  readonly name: string;
  /** Extra bare names resolving to the same implementation. */
  readonly aliases?: readonly string[];
  /** Operand syntax printed after the name in a usage line; `""` when none. */
  readonly usage: string;
  /** One-line description for command discovery and help output. */
  readonly summary: string;
  /**
   * How the applet participates in command resolution.
   *
   * - `program`, the default: an ordinary applet. Reachable at `/bin/NAME` and
   *   `/usr/bin/NAME`, and by bare name only when a `PATH` search is enabled
   *   and some component names one of those directories.
   * - `builtin`: a shell built-in that Linux also ships as a program, such as
   *   `echo` or `test`. Bash prefers the built-in, so it resolves by bare name
   *   regardless of `PATH`, and it still has an applet path.
   * - `session-builtin`: changes or inspects the calling session, so it has no
   *   program form at all. Linux has no `/bin/cd`, and neither does this.
   */
  readonly kind?: AppletKind;
  /** Option table, when the applet uses the shared scanner. */
  readonly options?: UtilityOptionParserConfig<Name>;
}

/** See `AppletSpec.kind`. */
export type AppletKind = "program" | "builtin" | "session-builtin";

export type AppletSpecWithOptions<Name extends string> = AppletSpec<Name> & {
  readonly options: UtilityOptionParserConfig<Name>;
};

/** A `ShellCommand` that also publishes its declarative specification. */
export interface ShellApplet<Name extends string = string> extends ShellCommand {
  readonly spec: AppletSpec<Name>;
}

/* @__NO_SIDE_EFFECTS__ */
export function defineApplet<Name extends string = string>(
  spec: AppletSpec<Name>,
  runner: AppletRunner,
): ShellApplet<Name> {
  return {
    name: spec.name,
    spec,
    run(context, argv, fds): ShellProcess {
      return {
        completed: Promise.resolve().then(async () => ({
          exitCode: await runner(context, argv, fds),
        })),
      };
    },
  };
}

/** Scans `argv` with the applet's declared option table. */
export function parseAppletOptions<Name extends string>(
  spec: AppletSpecWithOptions<Name>,
  argv: readonly string[],
): ParsedUtilityOptions<Name> {
  return parseUtilityOptions(spec.name, argv, spec.options, formatAppletUsage(spec));
}

/**
 * Builds the standard usage failure, which exits with status 2.
 *
 * The diagnostic names the applet, states what was wrong, and ends with the
 * declared synopsis, so a caller never has to guess the accepted spelling.
 */
export function appletUsageError(spec: AppletSpec, message: string): VfsError {
  return new VfsError("EINVAL", `${spec.name}: ${message}\n${formatAppletUsage(spec)}`);
}

/** Renders the one-line synopsis appended to a usage diagnostic. */
export function formatAppletUsage(spec: AppletSpec): string {
  return spec.usage === "" ? `usage: ${spec.name}` : `usage: ${spec.name} ${spec.usage}`;
}

/**
 * Returns the applet name a virtual absolute path selects, or `undefined` when
 * the path is not an applet spelling.
 *
 * The fast path is a single character comparison, so an ordinary bare-name
 * command performs no path parsing and allocates nothing.
 */
export function appletPathName(name: string): string | undefined {
  if (name.charCodeAt(0) !== SLASH) return undefined;
  const separator = name.lastIndexOf("/");
  const base = name.slice(separator + 1);
  if (base === "" || base === "." || base === "..") return undefined;
  return APPLET_DIRECTORIES.includes(name.slice(0, separator)) ? base : undefined;
}

/**
 * What a registered name is.
 *
 * `program` is an ordinary applet: reachable at `/bin/NAME`, and by bare name
 * only through a `PATH` component naming an applet directory. `builtin` is a
 * Bash built-in that Linux also ships as a program, so it resolves without a
 * search and still has an applet path. `session-builtin` changes or inspects
 * the calling session and therefore has no program form at all.
 */
export interface AppletEntry {
  readonly command: ShellCommand;
  readonly kind: AppletKind;
}

/**
 * Splits a `PATH` value into components.
 *
 * Components are returned exactly as written, including empty ones. POSIX
 * gives an empty component to the working directory, and the caller decides
 * what a component can supply.
 */
export function splitSearchPath(value: string): string[] {
  return value.split(":");
}

/**
 * Indexed multicall resolver.
 *
 * One implementation is reachable through its canonical name, its declared
 * aliases, and the virtual applet directories. Every spelling returns the same
 * `ShellCommand` object, so callers can compare identity and report the
 * canonical name for policy decisions and diagnostics.
 *
 * The registry answers about one name or one directory at a time and never
 * walks `PATH` itself. Ordering a search across components belongs to the
 * shell, which is the only layer that can also consult the namespace.
 */
export interface AppletRegistry {
  /** Registered commands in registration order. */
  readonly commands: readonly ShellCommand[];
  /** Looks up a bare name or a declared alias, ignoring `PATH`. */
  find(name: string): AppletEntry | undefined;
  /** Whether a `PATH` component is one of the virtual applet directories. */
  isAppletDirectory(directory: string): boolean;
  /** Resolves an absolute applet path such as `/bin/cat`. */
  findPath(path: string): AppletEntry | undefined;
  /**
   * Every resolvable bare name, including declared aliases, in UTF-8 byte
   * order. Help and completion enumerate through this rather than rebuilding
   * the index from specifications.
   */
  names(): readonly string[];
}

export function createAppletRegistry(commands: readonly ShellCommand[]): AppletRegistry {
  // Snapshot the caller's array so `commands` and `find` can never disagree.
  const registered = [...commands];
  const byName = new Map<string, AppletEntry>();
  for (const command of registered) {
    const spec = (command as Partial<ShellApplet>).spec;
    const entry: AppletEntry = { command, kind: spec?.kind ?? "program" };
    for (const name of [command.name, ...(spec?.aliases ?? [])]) {
      if (byName.has(name)) throw new VfsError("EINVAL", `duplicate command: ${name}`);
      byName.set(name, entry);
    }
  }
  let sortedNames: readonly string[] | undefined;
  return {
    commands: registered,
    find(name: string): AppletEntry | undefined {
      return byName.get(name);
    },
    isAppletDirectory(directory: string): boolean {
      return APPLET_DIRECTORIES.includes(directory);
    },
    names(): readonly string[] {
      // The index never changes, so sort once: completion asks per keystroke.
      sortedNames ??= [...byName.keys()].sort(compareUtf8);
      return sortedNames;
    },
    findPath(path: string): AppletEntry | undefined {
      const base = appletPathName(path);
      if (base === undefined) return undefined;
      const entry = byName.get(base);
      // A session-scoped built-in has no program form, so no path selects it.
      return entry === undefined || entry.kind === "session-builtin" ? undefined : entry;
    },
  };
}

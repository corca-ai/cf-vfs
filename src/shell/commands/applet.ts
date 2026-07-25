import { VfsError } from "../../core/errors.js";
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
   * - absent, the default: an ordinary program. Reachable at `/bin/NAME` and
   *   `/usr/bin/NAME`, and by bare name only when `PATH` names one of those
   *   directories.
   * - `builtin`: a shell built-in that Linux also ships as a program, such as
   *   `echo` or `test`. Bash prefers the built-in, so it resolves by bare name
   *   regardless of `PATH`, and it still has an applet path.
   * - `shell-builtin`: changes or inspects the calling session, so it has no
   *   program form at all. Linux has no `/bin/cd`, and neither does this.
   */
  readonly kind?: "builtin" | "shell-builtin";
  /** Option table, when the applet uses the shared scanner. */
  readonly options?: UtilityOptionParserConfig<Name>;
}

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
 * How a name reached its implementation.
 *
 * `builtin` means the name resolved without consulting `PATH`, exactly as Bash
 * resolves its built-ins. `program` means a `PATH` search or an absolute applet
 * path selected it.
 */
export interface AppletResolution {
  readonly command: ShellCommand;
  readonly kind: "builtin" | "program";
  /**
   * The applet path this name has, when it has one and a search found it.
   *
   * Absent for a session-scoped built-in, which has no program form, and for a
   * bare name resolved without a `PATH`, where nothing was searched.
   */
  readonly path?: string;
}

/**
 * Splits a `PATH` value into components.
 *
 * An empty component means the working directory in POSIX. No directory in the
 * namespace can supply a command yet, so an empty component contributes
 * nothing here rather than being silently treated as an applet directory.
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
 */
export interface AppletRegistry {
  /** Registered commands in registration order. */
  readonly commands: readonly ShellCommand[];
  /**
   * Resolves a bare name, declared alias, or virtual applet path.
   *
   * `searchPath` is the session's `PATH`. When it is `undefined` every
   * registered applet answers to its bare name, which is what a `Shell`
   * configured without the Linux profile expects. When it is present, a
   * non-built-in applet answers to a bare name only if some component names a
   * virtual applet directory, and components are searched left to right.
   */
  resolve(name: string, searchPath?: string): AppletResolution | undefined;
  /** The implementation `resolve` selects, or `undefined`. */
  lookup(name: string, searchPath?: string): ShellCommand | undefined;
}

export function createAppletRegistry(commands: readonly ShellCommand[]): AppletRegistry {
  // Snapshot the caller's array so `commands` and `lookup` can never disagree.
  const registered = [...commands];
  const byName = new Map<string, ShellCommand>();
  // Names with a program form, and names that resolve without consulting PATH.
  const programs = new Map<string, ShellCommand>();
  const builtins = new Set<string>();
  for (const command of registered) {
    const spec = (command as Partial<ShellApplet>).spec;
    const aliases = spec?.aliases ?? [];
    for (const name of [command.name, ...aliases]) {
      if (byName.has(name)) throw new VfsError("EINVAL", `duplicate command: ${name}`);
      byName.set(name, command);
      if (spec?.kind !== "shell-builtin") programs.set(name, command);
      if (spec?.kind !== undefined) builtins.add(name);
    }
  }

  // Left to right, first match wins, so a duplicated component is harmless and
  // the reported path is always the one that would run. Every applet is present
  // in every applet directory, so the component alone decides the result.
  const searchDirectory = (searchPath: string): string | undefined =>
    splitSearchPath(searchPath).find((directory) => APPLET_DIRECTORIES.includes(directory));

  const resolve = (name: string, searchPath?: string): AppletResolution | undefined => {
    const base = appletPathName(name);
    if (base !== undefined) {
      // An absolute applet path bypasses PATH, exactly as in Linux.
      const command = programs.get(base);
      return command === undefined
        ? undefined
        : { command, kind: "program", path: `${name.slice(0, name.lastIndexOf("/"))}/${base}` };
    }
    const command = byName.get(name);
    if (command === undefined) return undefined;
    const directory =
      searchPath === undefined || !programs.has(name) ? undefined : searchDirectory(searchPath);
    if (builtins.has(name)) {
      // A built-in resolves whatever PATH says. It still reports the applet
      // path it has, so `which echo` can find one.
      return directory === undefined
        ? { command, kind: "builtin" }
        : { command, kind: "builtin", path: `${directory}/${name}` };
    }
    if (searchPath === undefined) return { command, kind: "program" };
    return directory === undefined
      ? undefined
      : { command, kind: "program", path: `${directory}/${name}` };
  };

  return {
    commands: registered,
    resolve,
    lookup(name: string, searchPath?: string): ShellCommand | undefined {
      return resolve(name, searchPath)?.command;
    },
  };
}

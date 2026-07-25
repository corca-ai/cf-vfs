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
 * cannot break command resolution.
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
  return parseUtilityOptions(spec.name, argv, spec.options);
}

/** Builds the standard `name: message` usage failure, which exits with 2. */
export function appletUsageError(spec: AppletSpec, message: string): VfsError {
  return new VfsError("EINVAL", `${spec.name}: ${message}`);
}

/** Renders the one-line usage synopsis used by help and usage diagnostics. */
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
  /** Resolves a bare name, declared alias, or virtual applet path. */
  lookup(name: string): ShellCommand | undefined;
}

export function createAppletRegistry(commands: readonly ShellCommand[]): AppletRegistry {
  const byName = new Map<string, ShellCommand>();
  for (const command of commands) {
    const spec = (command as Partial<ShellApplet>).spec;
    for (const name of [command.name, ...(spec?.aliases ?? [])]) {
      if (byName.has(name)) throw new VfsError("EINVAL", `duplicate command: ${name}`);
      byName.set(name, command);
    }
  }
  return {
    commands,
    lookup(name: string): ShellCommand | undefined {
      const direct = byName.get(name);
      if (direct !== undefined) return direct;
      const base = appletPathName(name);
      return base === undefined ? undefined : byName.get(base);
    },
  };
}

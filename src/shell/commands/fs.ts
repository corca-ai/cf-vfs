import { VfsError } from "../../core/errors.js";
import type { VfsStat } from "../../vfs/types.js";
import {
  identityLabel,
  type ResolvedIdentityIds,
  type ResolvedIdentityNames,
  resolveIdentityIds,
  resolveIdentityNames,
  type ShellIdentitySource,
} from "../identity.js";
import {
  type AppletSpec,
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import { isRegularFile, modeString } from "./format.js";
import { describeKind } from "./fs-content.js";
import { commandPath, destinationPath, writeText } from "./helpers.js";

export { catCommand, fileCommand } from "./fs-content.js";
export { duCommand, findCommand, treeCommand } from "./fs-find.js";
export { basenameCommand, dirnameCommand, mktempCommand, realpathCommand } from "./fs-path.js";

const MKDIR = {
  name: "mkdir",
  usage: "[-p] [-m MODE] DIRECTORY...",
  summary: "creates directories",
  options: {
    short: {
      p: { name: "parents" },
      m: { name: "mode", argument: true },
    },
    long: {
      parents: { name: "parents" },
      mode: { name: "mode", argument: true },
    },
  },
} as const satisfies AppletSpecWithOptions<"parents" | "mode">;

const TOUCH = {
  name: "touch",
  usage: "[-c] FILE...",
  summary: "updates modification times and creates missing files",
  options: {
    short: { c: { name: "no-create" } },
    long: { "no-create": { name: "no-create" } },
  },
} as const satisfies AppletSpecWithOptions<"no-create">;

const RM = {
  name: "rm",
  usage: "[-rRf] PATH...",
  summary: "removes files and, with -r, directory subtrees",
  options: {
    short: {
      r: { name: "recursive" },
      R: { name: "recursive" },
      f: { name: "force" },
    },
    long: {
      recursive: { name: "recursive" },
      force: { name: "force" },
    },
  },
} as const satisfies AppletSpecWithOptions<"recursive" | "force">;

const RMDIR = {
  name: "rmdir",
  usage: "DIRECTORY...",
  summary: "removes empty directories",
} as const satisfies AppletSpec;

const MV = {
  name: "mv",
  usage: "[-f] SOURCE DESTINATION",
  summary: "renames a path, replacing the destination only with -f",
  options: {
    short: { f: { name: "force" } },
    long: { force: { name: "force" } },
  },
} as const satisfies AppletSpecWithOptions<"force">;

const CP = {
  name: "cp",
  usage: "[-rRfpP] SOURCE DESTINATION",
  summary: "copies a file or, with -r, a directory subtree",
  options: {
    short: {
      f: { name: "force" },
      r: { name: "recursive" },
      R: { name: "recursive" },
      p: { name: "preserve" },
      P: { name: "no-dereference" },
    },
    long: {
      force: { name: "force" },
      recursive: { name: "recursive" },
      preserve: { name: "preserve" },
      "no-dereference": { name: "no-dereference" },
    },
  },
} as const satisfies AppletSpecWithOptions<"force" | "recursive" | "preserve" | "no-dereference">;

const STAT = {
  name: "stat",
  usage: "[-L] [-c FORMAT] PATH...",
  summary: "prints size, kind, ownership, mode, revision, and mutation token",
  options: {
    short: { c: { name: "format", argument: true }, L: { name: "dereference" } },
    long: { format: { name: "format", argument: true }, dereference: { name: "dereference" } },
  },
} as const satisfies AppletSpecWithOptions<"format" | "dereference">;

const CHMOD = {
  name: "chmod",
  usage: "OCTAL-MODE|SYMBOLIC-MODE PATH...",
  summary: "sets the mode bits of a path",
} as const satisfies AppletSpec;

const CHOWN = {
  name: "chown",
  usage: "OWNER[:GROUP]|:GROUP PATH...",
  summary: "sets owner and group identifiers",
} as const satisfies AppletSpec;

const SYMBOLIC_MODE = /^([ugoa]*)([-+=])([rwx]*)$/u;
const MODE_CLASSES = [
  ["u", 6],
  ["g", 3],
  ["o", 0],
] as const;

function requestedPermissionBits(permissions: string): number {
  let bits = 0;
  if (permissions.includes("r")) bits |= 0o4;
  if (permissions.includes("w")) bits |= 0o2;
  if (permissions.includes("x")) bits |= 0o1;
  return bits;
}

function selectedModeBits(who: string, permissions: string): number {
  const requested = requestedPermissionBits(permissions);
  let bits = 0;
  for (const [name, shift] of MODE_CLASSES) {
    if (who.includes(name)) bits |= requested << shift;
  }
  return bits;
}

function clearSelectedModeBits(permission: number, who: string): number {
  let cleared = permission;
  for (const [name, shift] of MODE_CLASSES) {
    if (who.includes(name)) cleared &= ~(0o7 << shift);
  }
  return cleared;
}

/**
 * Applies one symbolic mode clause to existing permission bits.
 *
 * The profile covers the spellings scripts actually use — `+x`, `u+x`,
 * `go-w`, `a=rx` — and nothing else. `s`, `t`, `X`, numeric copies such as
 * `u=g`, and an omitted `umask` interaction are outside it, so an unsupported
 * clause is a usage error rather than an approximation.
 */
function applySymbolicMode(permission: number, clause: string, spec: AppletSpec): number {
  const match = SYMBOLIC_MODE.exec(clause);
  if (match === null) throw appletUsageError(spec, `unsupported mode: ${clause}`);
  const [, whoValue = "", operator = "", permissions = ""] = match;
  // A bare operator means every class, exactly as `chmod +x` does.
  const who = whoValue === "" || whoValue.includes("a") ? "ugo" : whoValue;
  const bits = selectedModeBits(who, permissions);
  if (operator === "+") return permission | bits;
  if (operator === "-") return permission & ~bits;
  // `=` replaces only the classes the clause names.
  return clearSelectedModeBits(permission, who) | bits;
}

export const mkdirCommand = /* @__PURE__ */ defineApplet(MKDIR, async (context, argv) => {
  const parsed = parseAppletOptions(MKDIR, argv);
  const recursive = parsed.options.some((option) => option.name === "parents");
  let mode: number | undefined;
  for (const option of parsed.options) {
    if (option.name === "mode" && "argument" in option) {
      if (!/^[0-7]{3,4}$/u.test(option.argument)) {
        throw appletUsageError(MKDIR, "mode must be octal");
      }
      mode = 0o040000 | Number.parseInt(option.argument, 8);
    }
  }
  if (parsed.operands.length === 0) throw appletUsageError(MKDIR, "missing operand");
  for (const path of parsed.operands) {
    context.fileSystem.mkdir(commandPath(context, path), recursive, mode);
  }
  return 0;
});

export const touchCommand = /* @__PURE__ */ defineApplet(TOUCH, async (context, argv) => {
  const parsed = parseAppletOptions(TOUCH, argv);
  const create = !parsed.options.some((option) => option.name === "no-create");
  if (parsed.operands.length === 0) throw appletUsageError(TOUCH, "missing operand");
  for (const path of parsed.operands) {
    try {
      context.fileSystem.touch(commandPath(context, path), { create });
    } catch (error) {
      if (!(!create && error instanceof VfsError && error.code === "ENOENT")) throw error;
    }
  }
  return 0;
});

export const rmCommand = /* @__PURE__ */ defineApplet(RM, async (context, argv) => {
  const parsed = parseAppletOptions(RM, argv);
  const recursive = parsed.options.some((option) => option.name === "recursive");
  const force = parsed.options.some((option) => option.name === "force");
  if (parsed.operands.length === 0 && !force) throw appletUsageError(RM, "missing operand");
  for (const path of parsed.operands) {
    try {
      await context.fileSystem.remove(commandPath(context, path), { recursive });
    } catch (error) {
      if (!(force && error instanceof VfsError && error.code === "ENOENT")) throw error;
    }
  }
  return 0;
});

export const rmdirCommand = /* @__PURE__ */ defineApplet(RMDIR, async (context, argv) => {
  if (argv.length === 0) throw appletUsageError(RMDIR, "missing operand");
  for (const path of argv) {
    const normalized = commandPath(context, path);
    // The final component is the object `rmdir` removes; following a link here
    // would validate its target and then unlink the link itself.
    const stat = context.fileSystem.lstat(normalized);
    if (stat.kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", normalized);
    await context.fileSystem.remove(normalized);
  }
  return 0;
});

export const mvCommand = /* @__PURE__ */ defineApplet(MV, async (context, argv) => {
  const parsed = parseAppletOptions(MV, argv);
  const replace = parsed.options.some((option) => option.name === "force");
  const values = parsed.operands;
  if (values.length !== 2) throw appletUsageError(MV, "requires source and destination");
  const source = commandPath(context, values[0]);
  const target = destinationPath(context, source, values[1] ?? "");
  await context.fileSystem.move(source, target, { replace });
  return 0;
});

export const cpCommand = /* @__PURE__ */ defineApplet(CP, async (context, argv) => {
  const parsed = parseAppletOptions(CP, argv);
  const replace = parsed.options.some((option) => option.name === "force");
  const recursive = parsed.options.some((option) => option.name === "recursive");
  const preserve = parsed.options.some((option) => option.name === "preserve");
  const noDereference = parsed.options.some((option) => option.name === "no-dereference");
  const values = parsed.operands;
  if (values.length !== 2) throw appletUsageError(CP, "requires source and destination");
  const source = commandPath(context, values[0]);
  const target = destinationPath(context, source, values[1] ?? "");
  // A named link is copied through, as GNU does; `-r` and `-P` copy the link
  // itself, because a subtree full of dereferenced links is a different tree.
  const dereference = !recursive && !noDereference;
  // The metadata of what was copied, which is the target when the copy
  // followed the link and the link itself when it did not.
  const preserved = preserve
    ? dereference
      ? context.fileSystem.stat(source)
      : context.fileSystem.lstat(source)
    : undefined;
  await context.fileSystem.copy(source, target, { replace, recursive, dereference });
  // Mode bits and the modification time are the metadata `-p` preserves in
  // this profile. A credential-bound copy deliberately creates actor-owned
  // entries rather than attempting privileged ownership preservation. A copy
  // carries each entry's own bits already but stamps every entry with the
  // current time, so the named target is restated here. Descendants of a
  // recursive copy keep the copy's time, which is a declared divergence.
  // A copied link is skipped: its mode is fixed, and `setMetadata` follows, so
  // restating it would stamp whatever it points at instead.
  if (preserved !== undefined && preserved.kind !== "symlink") {
    context.fileSystem.setMetadata(target, {
      mode: preserved.mode,
      modifiedAtMs: preserved.modifiedAtMs,
    });
  }
  return 0;
});

function statIdentity(values: ReadonlyMap<number, string> | undefined, id: number): string {
  const name = values?.get(id);
  return name === undefined ? String(id) : `${id} (${name})`;
}

function statText(stat: VfsStat, identities: ResolvedIdentityNames | undefined): string {
  return `${[
    `  File: ${stat.path}`,
    `  Size: ${stat.sizeBytes}`,
    `  Type: ${
      stat.kind === "symlink"
        ? `symbolic link -> ${stat.linkTarget}`
        : stat.kind === "file" && isRegularFile(stat)
          ? `${stat.contentClass} file`
          : describeKind(stat)
    }`,
    `  Mode: ${stat.mode.toString(8)} (${modeString(stat.mode)})`,
    ` Owner: ${statIdentity(identities?.users, stat.uid)}`,
    ` Group: ${statIdentity(identities?.groups, stat.gid)}`,
    `Revision: ${stat.revision}`,
    `Mutation: ${stat.mutationToken}`,
  ].join("\n")}\n`;
}

/**
 * Prints entry metadata.
 *
 * `-c` selects a machine-stable format so a script can read one field without
 * parsing a human report. The conversions name what this namespace actually
 * has. `%i` answers now that an entry carries an identity; the link-count
 * conversion is still refused rather than filled with a placeholder, because
 * a hard link remains inexpressible here and a constant `1` would read as a
 * fact rather than as the absence of one.
 */
export const statCommand = /* @__PURE__ */ defineApplet(STAT, async (context, argv, fds) => {
  const parsed = parseAppletOptions(STAT, argv);
  const format = parsed.options.find(
    (option): option is { name: "format"; argument: string } =>
      option.name === "format" && "argument" in option,
  )?.argument;
  if (parsed.operands.length === 0) throw appletUsageError(STAT, "missing operand");
  // GNU reports the link itself unless `-L` is given, so `stat link` says
  // "symbolic link" and does not quietly describe something else.
  const dereference = parsed.options.some((option) => option.name === "dereference");
  const entries = parsed.operands.map((path) => {
    const resolved = commandPath(context, path);
    const stat = dereference
      ? context.fileSystem.stat(resolved)
      : context.fileSystem.lstat(resolved);
    return { path, stat };
  });
  const identityFields =
    format === undefined ? { users: true, groups: true } : statIdentityFields(format);
  const identities =
    context.identities !== undefined && (identityFields.users || identityFields.groups)
      ? await resolveIdentityNames(
          context.identities,
          identityFields.users ? entries.map(({ stat }) => stat.uid) : [],
          identityFields.groups ? entries.map(({ stat }) => stat.gid) : [],
        )
      : undefined;
  for (const { path, stat } of entries) {
    await writeText(
      fds[1],
      format === undefined
        ? statText(stat, identities)
        : `${statFormat(format, stat, path, identities)}\n`,
    );
  }
  return 0;
});

/** What `stat -c %F` and `file` call an entry, from the mode's type field. */
function statIdentityFields(format: string): { users: boolean; groups: boolean } {
  let users = false;
  let groups = false;
  for (let index = 0; index < format.length; index += 1) {
    if (format[index] === "\\") {
      index += 1;
      continue;
    }
    if (format[index] !== "%") continue;
    const conversion = format[++index];
    if (conversion === "U") users = true;
    else if (conversion === "G") groups = true;
  }
  return { users, groups };
}

function statFormat(
  format: string,
  stat: VfsStat,
  operand: string,
  identities: ResolvedIdentityNames | undefined,
): string {
  let output = "";
  for (let index = 0; index < format.length; index += 1) {
    const character = format[index] ?? "";
    if (character === "\\") {
      const next = format[++index];
      output += statEscape(next);
      continue;
    }
    if (character !== "%") {
      output += character;
      continue;
    }
    const conversion = format[++index];
    const value = statConversion(conversion, stat, operand, identities);
    if (value === undefined) {
      throw appletUsageError(STAT, `unsupported conversion %${conversion ?? ""}`);
    }
    output += value;
  }
  return output;
}

function statEscape(value: string | undefined): string {
  if (value === "n") return "\n";
  if (value === "t") return "\t";
  return value ?? "\\";
}

function statConversion(
  conversion: string | undefined,
  stat: VfsStat,
  operand: string,
  identities: ResolvedIdentityNames | undefined,
): string | undefined {
  switch (conversion) {
    case "n":
      return operand;
    case "s":
      return String(stat.sizeBytes);
    case "i":
      return String(stat.ino);
    case "f":
      return stat.mode.toString(16);
    case "a":
      return (stat.mode & 0o7777).toString(8);
    case "A":
      return modeString(stat.mode);
    case "F":
      return describeKind(stat);
    case "u":
      return String(stat.uid);
    case "g":
      return String(stat.gid);
    case "U":
      return identityLabel(identities?.users, stat.uid);
    case "G":
      return identityLabel(identities?.groups, stat.gid);
    case "%":
      return "%";
    default:
      return undefined;
  }
}

export const chmodCommand = /* @__PURE__ */ defineApplet(CHMOD, async (context, argv) => {
  const [modeValue, ...paths] = argv;
  if (modeValue === undefined || paths.length === 0) {
    throw appletUsageError(CHMOD, "requires a mode and paths");
  }
  const octal = /^[0-7]{3,4}$/u.test(modeValue);
  const clauses = octal ? [] : modeValue.split(",");
  for (const path of paths) {
    const normalized = commandPath(context, path);
    const stat = context.fileSystem.stat(normalized);
    // A symbolic mode reads the current bits; an octal mode replaces them.
    let permission = octal ? Number.parseInt(modeValue, 8) : stat.mode & 0o7777;
    for (const clause of clauses) permission = applySymbolicMode(permission, clause, CHMOD);
    context.fileSystem.setMetadata(normalized, {
      mode: (stat.kind === "directory" ? 0o040000 : 0o100000) | permission,
    });
  }
  return 0;
});

function numericIdentity(part: string, kind: "owner" | "group"): number | undefined {
  if (!/^\d+$/u.test(part)) return undefined;
  const id = Number(part);
  if (!Number.isSafeInteger(id) || id > 0xffff_ffff) {
    throw appletUsageError(CHOWN, `${kind} is outside the unsigned 32-bit range`);
  }
  return id;
}

async function parseOwnership(
  value: string,
  identities: ShellIdentitySource | undefined,
): Promise<{ uid?: number; gid?: number }> {
  const parts = ownershipParts(value);
  const resolved = await resolveOwnershipParts(parts, identities);
  const uid = parts.numericUid ?? resolved.uid;
  const gid = parts.numericGid ?? resolved.gid;
  return {
    ...(uid === undefined ? {} : { uid }),
    ...(gid === undefined ? {} : { gid }),
  };
}

interface OwnershipParts {
  readonly numericUid?: number;
  readonly numericGid?: number;
  readonly userName?: string;
  readonly groupName?: string;
}

function ownershipParts(value: string): OwnershipParts {
  const { owner, group } = splitOwnership(value);
  const ownerPart = identityPart(owner, "owner");
  const groupPart = identityPart(group, "group");
  return {
    ...(ownerPart.numeric === undefined ? {} : { numericUid: ownerPart.numeric }),
    ...(groupPart.numeric === undefined ? {} : { numericGid: groupPart.numeric }),
    ...(ownerPart.name === undefined ? {} : { userName: ownerPart.name }),
    ...(groupPart.name === undefined ? {} : { groupName: groupPart.name }),
  };
}

function splitOwnership(value: string): { owner: string; group?: string } {
  const separator = value.indexOf(":");
  if (separator !== value.lastIndexOf(":")) {
    throw appletUsageError(CHOWN, "owner and group must contain at most one colon");
  }
  const owner = separator < 0 ? value : value.slice(0, separator);
  const group = separator < 0 ? undefined : value.slice(separator + 1);
  if (owner.length === 0 && (group === undefined || group.length === 0)) {
    throw appletUsageError(CHOWN, "requires an owner or group");
  }
  return { owner, ...(group === undefined ? {} : { group }) };
}

function identityPart(
  value: string | undefined,
  kind: "owner" | "group",
): { numeric?: number; name?: string } {
  if (value === undefined || value === "") return {};
  const numeric = numericIdentity(value, kind);
  return numeric === undefined ? { name: value } : { numeric };
}

async function resolveOwnershipParts(
  parts: OwnershipParts,
  identities: ShellIdentitySource | undefined,
): Promise<{ uid?: number; gid?: number }> {
  if (parts.userName === undefined && parts.groupName === undefined) return {};
  if (identities === undefined) {
    throw new VfsError("ENOTSUP", "chown: user and group name lookup is not available");
  }
  const resolved = await resolveIdentityIds(
    identities,
    parts.userName === undefined ? [] : [parts.userName],
    parts.groupName === undefined ? [] : [parts.groupName],
  );
  return resolvedOwnership(parts, resolved);
}

function resolvedOwnership(
  parts: OwnershipParts,
  resolved: ResolvedIdentityIds,
): { uid?: number; gid?: number } {
  const uid = parts.userName === undefined ? undefined : resolved.users.get(parts.userName);
  const gid = parts.groupName === undefined ? undefined : resolved.groups.get(parts.groupName);
  if (parts.userName !== undefined && uid === undefined) {
    throw new VfsError("ENOENT", `chown: unknown user: ${parts.userName}`);
  }
  if (parts.groupName !== undefined && gid === undefined) {
    throw new VfsError("ENOENT", `chown: unknown group: ${parts.groupName}`);
  }
  return { ...(uid === undefined ? {} : { uid }), ...(gid === undefined ? {} : { gid }) };
}

export const chownCommand = /* @__PURE__ */ defineApplet(CHOWN, async (context, argv) => {
  const [owner, ...paths] = argv;
  if (owner === undefined || paths.length === 0) {
    throw appletUsageError(CHOWN, "requires an owner and paths");
  }
  const ownership = await parseOwnership(owner, context.identities);
  for (const path of paths) {
    context.fileSystem.setOwnership(commandPath(context, path), ownership);
  }
  return 0;
});

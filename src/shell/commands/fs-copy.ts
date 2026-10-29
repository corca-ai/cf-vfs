import { VfsError } from "../../core/errors.js";
import { basename, isDescendant } from "../../core/path.js";
import type { CopyOptions } from "../../vfs/types.js";
import type { ShellCommandContext } from "../types.js";
import {
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import { commandPath, destinationPath } from "./helpers.js";

const CP = {
  name: "cp",
  usage: "[-arRfnpP] SOURCE... DESTINATION",
  summary: "copies files or, with -r, directory subtrees",
  options: {
    short: {
      f: { name: "force" },
      n: { name: "no-clobber" },
      r: { name: "recursive" },
      R: { name: "recursive" },
      p: { name: "preserve" },
      P: { name: "no-dereference" },
      a: { name: "archive" },
    },
    long: {
      force: { name: "force" },
      "no-clobber": { name: "no-clobber" },
      recursive: { name: "recursive" },
      preserve: { name: "preserve" },
      "no-dereference": { name: "no-dereference" },
      archive: { name: "archive" },
    },
  },
} as const satisfies AppletSpecWithOptions<
  "force" | "no-clobber" | "recursive" | "preserve" | "no-dereference" | "archive"
>;

/** A source whose final component is `.` names a directory's contents, as in `cp -r src/. dst`. */
const CONTENTS_OPERAND = /(?:^|\/)\.\/*$/u;

/**
 * Copies a directory's children into an existing directory, merging each
 * subdirectory that already exists there, the way GNU `cp -r` treats an
 * existing destination directory. Like GNU, a failure part-way leaves what was
 * already copied.
 */
async function copyInto(
  context: ShellCommandContext,
  source: string,
  target: string,
  options: CopyOptions,
  noClobber: boolean,
): Promise<void> {
  if (source === target || isDescendant(source, target)) {
    throw new VfsError("EINVAL", "cannot copy a directory into itself", target);
  }
  for (const child of context.fileSystem.list(source)) {
    const destination = `${target === "/" ? "" : target}/${basename(child.path)}`;
    if (
      child.kind === "directory" &&
      context.fileSystem.inspectWriteTarget(destination, true)?.kind === "directory"
    ) {
      await copyInto(context, child.path, destination, options, noClobber);
    } else if (!noClobber || context.fileSystem.inspectWriteTarget(destination, false) === null) {
      await context.fileSystem.copy(child.path, destination, options);
    }
  }
}

interface CopyRequest {
  readonly recursive: boolean;
  readonly preserve: boolean;
  readonly noDereference: boolean;
  readonly noClobber: boolean;
}

/**
 * Copies one operand. Like GNU, an existing file is overwritten unless `-n`
 * asks to keep it; `-f` is accepted for scripts that pass it.
 */
async function copyOperand(
  context: ShellCommandContext,
  sourceOperand: string,
  destinationOperand: string,
  request: CopyRequest,
): Promise<void> {
  const source = commandPath(context, sourceOperand);
  // `src/.` has no name of its own to add below an existing destination.
  const target = CONTENTS_OPERAND.test(sourceOperand)
    ? commandPath(context, destinationOperand)
    : destinationPath(context, source, destinationOperand);
  // A named link is copied through, as GNU does; `-r` and `-P` copy the link
  // itself, because a subtree full of dereferenced links is a different tree.
  const dereference = !request.recursive && !request.noDereference;
  // The metadata of what was copied, which is the target when the copy
  // followed the link and the link itself when it did not.
  const preserved = request.preserve
    ? dereference
      ? context.fileSystem.stat(source)
      : context.fileSystem.lstat(source)
    : undefined;
  const existing = context.fileSystem.inspectWriteTarget(target, true);
  const merge =
    request.recursive &&
    context.fileSystem.lstat(source).kind === "directory" &&
    existing?.kind === "directory";
  const options = { replace: !request.noClobber, recursive: request.recursive };
  if (merge) await copyInto(context, source, target, options, request.noClobber);
  else if (request.noClobber && existing !== null) return;
  else await context.fileSystem.copy(source, target, { ...options, dereference });
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
}

/** With more than one source, the destination must be an existing directory. */
export function requireDirectoryTarget(
  context: ShellCommandContext,
  operands: readonly string[],
): void {
  if (operands.length <= 2) return;
  const destination = operands.at(-1) ?? "";
  const target = context.fileSystem.inspectWriteTarget(commandPath(context, destination), true);
  if (target?.kind !== "directory") {
    throw new VfsError("ENOTDIR", `target '${destination}' is not a directory`);
  }
}

export const cpCommand = /* @__PURE__ */ defineApplet(CP, async (context, argv) => {
  const parsed = parseAppletOptions(CP, argv);
  const has = (name: string): boolean => parsed.options.some((option) => option.name === name);
  const request: CopyRequest = {
    // `-a` is GNU's `-dR --preserve=all`: recursive, links kept, metadata kept.
    recursive: has("recursive") || has("archive"),
    preserve: has("preserve") || has("archive"),
    noDereference: has("no-dereference") || has("archive"),
    noClobber: has("no-clobber"),
  };
  const values = parsed.operands;
  if (values.length < 2) throw appletUsageError(CP, "requires source and destination");
  requireDirectoryTarget(context, values);
  const destination = values.at(-1) ?? "";
  for (const source of values.slice(0, -1)) {
    await copyOperand(context, source, destination, request);
  }
  return 0;
});

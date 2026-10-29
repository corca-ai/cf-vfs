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
      await copyInto(context, child.path, destination, options);
    } else {
      await context.fileSystem.copy(child.path, destination, options);
    }
  }
}

export const cpCommand = /* @__PURE__ */ defineApplet(CP, async (context, argv) => {
  const parsed = parseAppletOptions(CP, argv);
  const replace = parsed.options.some((option) => option.name === "force");
  const recursive = parsed.options.some((option) => option.name === "recursive");
  const preserve = parsed.options.some((option) => option.name === "preserve");
  const noDereference = parsed.options.some((option) => option.name === "no-dereference");
  const values = parsed.operands;
  if (values.length !== 2) throw appletUsageError(CP, "requires source and destination");
  const sourceOperand = values[0] ?? "";
  const source = commandPath(context, sourceOperand);
  // `src/.` has no name of its own to add below an existing destination.
  const target = CONTENTS_OPERAND.test(sourceOperand)
    ? commandPath(context, values[1] ?? "")
    : destinationPath(context, source, values[1] ?? "");
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
  const merge =
    recursive &&
    context.fileSystem.lstat(source).kind === "directory" &&
    context.fileSystem.inspectWriteTarget(target, true)?.kind === "directory";
  if (merge) await copyInto(context, source, target, { replace, recursive });
  else await context.fileSystem.copy(source, target, { replace, recursive, dereference });
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

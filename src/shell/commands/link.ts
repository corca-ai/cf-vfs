import { VfsError } from "../../core/errors.js";
import { dirname } from "../../core/path.js";
import {
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import { commandPath, destinationPath, writeText } from "./helpers.js";

const LN = {
  name: "ln",
  usage: "-s [-f] TARGET LINK",
  summary: "creates a symbolic link",
  options: {
    short: {
      s: { name: "symbolic" },
      f: { name: "force" },
    },
    long: {
      symbolic: { name: "symbolic" },
      force: { name: "force" },
    },
  },
} as const satisfies AppletSpecWithOptions<"symbolic" | "force">;

const READLINK = {
  name: "readlink",
  usage: "[-f] PATH...",
  summary: "prints the target of a symbolic link",
  options: {
    short: { f: { name: "canonicalize" } },
    long: { canonicalize: { name: "canonicalize" } },
  },
} as const satisfies AppletSpecWithOptions<"canonicalize">;

/**
 * Creates a symbolic link.
 *
 * Only `-s` is in the profile: a hard link needs a link count and an inode
 * identity separate from the path, and this namespace has neither, so the
 * option is refused rather than quietly making a copy that would diverge the
 * moment either side was written.
 *
 * The target is stored exactly as given. It is not resolved, not required to
 * exist, and not rewritten to an absolute path — a relative target is what
 * makes a tree relocatable, and resolving it here would silently destroy that.
 *
 * `-n` is absent rather than accepted and ignored: this profile never
 * dereferences an existing link at the destination, so the behaviour GNU's
 * `-n` selects is the only behaviour there is, and an option that changes
 * nothing reads as one that does.
 */
export const lnCommand = /* @__PURE__ */ defineApplet(LN, async (context, argv) => {
  const parsed = parseAppletOptions(LN, argv);
  const has = (name: string): boolean => parsed.options.some((option) => option.name === name);
  if (!has("symbolic")) {
    throw appletUsageError(LN, "only symbolic links are supported; use -s");
  }
  const [target, name, ...rest] = parsed.operands;
  if (target === undefined || rest.length > 0) {
    throw appletUsageError(LN, "requires a target and a link name");
  }
  // `ln -s target` with no name links into the working directory under the
  // target's own basename, as GNU does.
  const linkName = name ?? target.split("/").pop() ?? "";
  if (linkName === "") throw appletUsageError(LN, "requires a link name");
  // An existing directory as the destination means "inside it", the way `mv`
  // and `cp` read the same operand. An inferred name is already the final path:
  // treating it as an explicit destination a second time would turn `ln -s
  // /missing/foo` into `foo/foo` whenever `./foo` is a directory.
  const path =
    name === undefined ? commandPath(context, linkName) : destinationPath(context, target, name);
  context.budget.mutation();
  context.fileSystem.symlink(path, target, { replace: has("force") });
  return 0;
});

/**
 * Prints where a link points.
 *
 * Without `-f` this is the stored target verbatim, which is what `readlink`
 * means: a path that is not a link is not an error to be explained but a
 * silent status 1, because the usual caller is a conditional.
 *
 * With `-f` it is the canonical path instead, resolved through every link on
 * the way. That form tolerates a missing final component, as GNU's does, so it
 * can name a file that has not been created yet.
 */
export const readlinkCommand = /* @__PURE__ */ defineApplet(
  READLINK,
  async (context, argv, fds) => {
    const parsed = parseAppletOptions(READLINK, argv);
    const canonicalize = parsed.options.some((option) => option.name === "canonicalize");
    if (parsed.operands.length === 0) throw appletUsageError(READLINK, "missing operand");
    let failed = false;
    for (const operand of parsed.operands) {
      const path = commandPath(context, operand);
      context.budget.step();
      try {
        let value: string;
        if (canonicalize) {
          // Only the final component may be absent. GNU refuses a missing
          // parent, and so must this, or `readlink -f` would happily echo back
          // a path that could never exist.
          context.fileSystem.stat(dirname(path));
          value = context.fileSystem.realpath(path);
        } else {
          value = context.fileSystem.readlink(path);
        }
        await writeText(fds[1], `${value}\n`);
      } catch (error) {
        // A path that is not a link, or is not there, is reported by the status
        // alone. GNU prints nothing here either.
        if (
          error instanceof VfsError &&
          (error.code === "EINVAL" || error.code === "ENOENT" || error.code === "ENOTDIR")
        ) {
          failed = true;
          continue;
        }
        throw error;
      }
    }
    return failed ? 1 : 0;
  },
);

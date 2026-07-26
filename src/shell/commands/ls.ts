import { VfsError } from "../../core/errors.js";
import type { VfsStat } from "../../vfs/types.js";
import { identityLabel, type ResolvedIdentityNames, resolveIdentityNames } from "../identity.js";
import { type AppletSpecWithOptions, defineApplet, parseAppletOptions } from "./applet.js";
import { modeString } from "./format.js";
import { BufferedTextWriter, commandPath } from "./helpers.js";

const LS = {
  name: "ls",
  usage: "[-adlnA1R] [PATH...]",
  summary: "lists directory entries or a single path",
  options: {
    short: {
      l: { name: "long" },
      n: { name: "numeric" },
      d: { name: "directory" },
      a: { name: "all" },
      A: { name: "all" },
      1: { name: "one-per-line" },
      R: { name: "recursive" },
    },
  },
} as const satisfies AppletSpecWithOptions<
  "long" | "numeric" | "directory" | "all" | "one-per-line" | "recursive"
>;

/**
 * Lists directory entries or a single path.
 *
 * Output is one entry per line whatever the terminal, so `-1` is accepted and
 * changes nothing: there is no column mode to turn off. `-R` walks the subtree
 * through the paged traversal and prints each directory under its own heading,
 * as `ls -R` does.
 */
export const lsCommand = /* @__PURE__ */ defineApplet(LS, async (context, argv, fds) => {
  const parsed = parseAppletOptions(LS, argv);
  const numeric = parsed.options.some((option) => option.name === "numeric");
  const long = numeric || parsed.options.some((option) => option.name === "long");
  const directory = parsed.options.some((option) => option.name === "directory");
  const recursive = parsed.options.some((option) => option.name === "recursive");
  const paths = parsed.operands.length === 0 ? ["."] : parsed.operands;
  const output = new BufferedTextWriter(context, fds[1]);
  const namesFor = (entries: readonly VfsStat[]): Promise<ResolvedIdentityNames> | undefined =>
    long && !numeric && context.identities !== undefined
      ? resolveIdentityNames(
          context.identities,
          entries.map((entry) => entry.uid),
          entries.map((entry) => entry.gid),
        )
      : undefined;
  const format = (
    entry: VfsStat,
    name: string,
    identities: ResolvedIdentityNames | undefined,
  ): string => {
    if (!long) return `${name}\n`;
    // The long form names the target, because a link's own size and mode say
    // nothing useful and the target is the thing a reader wants.
    const arrow = entry.kind === "symlink" ? ` -> ${entry.linkTarget}` : "";
    const owner = identities === undefined ? entry.uid : identityLabel(identities.users, entry.uid);
    const group =
      identities === undefined ? entry.gid : identityLabel(identities.groups, entry.gid);
    return `${modeString(entry.mode)} ${owner} ${group} ${entry.sizeBytes.toString().padStart(8)} ${name}${arrow}\n`;
  };
  let written = false;
  try {
    const listDirectory = async (
      path: string,
      heading: string | undefined,
    ): Promise<Array<{ path: string; display: string }>> => {
      const entries = context.fileSystem.list(path);
      const pendingIdentities = namesFor(entries);
      const identities = pendingIdentities === undefined ? undefined : await pendingIdentities;
      if (heading !== undefined) await output.write(`${written ? "\n" : ""}${heading}:\n`);
      written = true;
      for (const entry of entries) await output.write(format(entry, entry.name, identities));
      return entries
        .filter((entry) => entry.kind === "directory")
        .map((entry) => ({ path: entry.path, display: `${heading ?? path}/${entry.name}` }));
    };
    for (const path of paths) {
      const normalized = commandPath(context, path);
      const entry = context.fileSystem.lstat(normalized);
      // A link to a directory is listed through the way `ls dir` is, but `-l`
      // and `-d` both stop that: POSIX has them describe the operand, which is
      // why `ls -l dirlink` is one line about the link. Only a link needs the
      // second lookup; a directory is already the answer.
      const linksToDirectory = (): boolean => {
        try {
          return context.fileSystem.stat(normalized).kind === "directory";
        } catch (error) {
          // A link that leads nowhere is still an entry to describe: `ls
          // dangling` names it, as `ls` does, rather than failing and taking
          // the remaining operands with it. A refusal is not that — a link the
          // policy will not follow must still be refused, not quietly listed.
          if (
            error instanceof VfsError &&
            (error.code === "ENOENT" || error.code === "ELOOP" || error.code === "ENOTDIR")
          ) {
            return false;
          }
          throw error;
        }
      };
      const listsThrough =
        !directory &&
        (entry.kind === "directory" || (entry.kind === "symlink" && !long && linksToDirectory()));
      if (!listsThrough) {
        const pendingIdentities = namesFor([entry]);
        const identities = pendingIdentities === undefined ? undefined : await pendingIdentities;
        await output.write(format(entry, path, identities));
        written = true;
        continue;
      }
      const heading = recursive || paths.length > 1 ? path : undefined;
      const pending = await listDirectory(normalized, heading);
      if (!recursive) continue;
      // Breadth-first, so a subtree prints in the order `ls -R` uses.
      const queue = [...pending];
      while (queue.length > 0) {
        const next = queue.shift();
        if (next === undefined) break;
        context.budget.step();
        queue.push(...(await listDirectory(next.path, next.display)));
      }
    }
    await output.flush();
  } finally {
    output.abort();
  }
  return 0;
});

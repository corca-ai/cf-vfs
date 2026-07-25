import type { VfsStat } from "../../vfs/types.js";
import { type AppletSpecWithOptions, defineApplet, parseAppletOptions } from "./applet.js";
import { modeString } from "./format.js";
import { BufferedTextWriter, commandPath } from "./helpers.js";

const LS = {
  name: "ls",
  usage: "[-adlA1R] [PATH...]",
  summary: "lists directory entries or a single path",
  options: {
    short: {
      l: { name: "long" },
      d: { name: "directory" },
      a: { name: "all" },
      A: { name: "all" },
      1: { name: "one-per-line" },
      R: { name: "recursive" },
    },
  },
} as const satisfies AppletSpecWithOptions<
  "long" | "directory" | "all" | "one-per-line" | "recursive"
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
  const long = parsed.options.some((option) => option.name === "long");
  const directory = parsed.options.some((option) => option.name === "directory");
  const recursive = parsed.options.some((option) => option.name === "recursive");
  const paths = parsed.operands.length === 0 ? ["."] : parsed.operands;
  const output = new BufferedTextWriter(context, fds[1]);
  const format = (entry: VfsStat, name: string): string =>
    long
      ? `${modeString(entry.mode)} ${entry.sizeBytes.toString().padStart(8)} ${name}\n`
      : `${name}\n`;
  let written = false;
  try {
    const listDirectory = async (
      path: string,
      heading: string | undefined,
    ): Promise<Array<{ path: string; display: string }>> => {
      const entries = context.fileSystem.list(path);
      if (heading !== undefined) await output.write(`${written ? "\n" : ""}${heading}:\n`);
      written = true;
      for (const entry of entries) await output.write(format(entry, entry.name));
      return entries
        .filter((entry) => entry.kind === "directory")
        .map((entry) => ({ path: entry.path, display: `${heading ?? path}/${entry.name}` }));
    };
    for (const [index, path] of paths.entries()) {
      const normalized = commandPath(context, path);
      const stat = context.fileSystem.stat(normalized);
      if (stat.kind !== "directory" || directory) {
        await output.write(format(stat, path));
        written = true;
        continue;
      }
      const heading = recursive || paths.length > 1 ? path : undefined;
      void index;
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

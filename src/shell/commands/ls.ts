import { VfsError } from "../../core/errors.js";
import type { VfsStat } from "../../vfs/types.js";
import { identityLabel, type ResolvedIdentityNames, resolveIdentityNames } from "../identity.js";
import type { ShellCommandContext } from "../types.js";
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

function linkTargetsDirectory(context: ShellCommandContext, path: string): boolean {
  try {
    return context.fileSystem.stat(path).kind === "directory";
  } catch (error) {
    // A dangling or looping link remains an entry to describe. A policy
    // refusal is different and must still propagate.
    if (
      error instanceof VfsError &&
      (error.code === "ENOENT" || error.code === "ELOOP" || error.code === "ENOTDIR")
    ) {
      return false;
    }
    throw error;
  }
}

class LsWriter {
  readonly #context: ShellCommandContext;
  readonly #output: BufferedTextWriter;
  readonly #long: boolean;
  readonly #numeric: boolean;
  #written = false;

  constructor(
    context: ShellCommandContext,
    output: BufferedTextWriter,
    long: boolean,
    numeric: boolean,
  ) {
    this.#context = context;
    this.#output = output;
    this.#long = long;
    this.#numeric = numeric;
  }

  async #namesFor(entries: readonly VfsStat[]): Promise<ResolvedIdentityNames | undefined> {
    return this.#long && !this.#numeric && this.#context.identities !== undefined
      ? await resolveIdentityNames(
          this.#context.identities,
          entries.map((entry) => entry.uid),
          entries.map((entry) => entry.gid),
        )
      : undefined;
  }

  #format(entry: VfsStat, name: string, identities: ResolvedIdentityNames | undefined): string {
    if (!this.#long) return `${name}\n`;
    const arrow = entry.kind === "symlink" ? ` -> ${entry.linkTarget}` : "";
    const owner = identities === undefined ? entry.uid : identityLabel(identities.users, entry.uid);
    const group =
      identities === undefined ? entry.gid : identityLabel(identities.groups, entry.gid);
    return `${modeString(entry.mode)} ${owner} ${group} ${entry.sizeBytes.toString().padStart(8)} ${name}${arrow}\n`;
  }

  async entry(entry: VfsStat, name: string): Promise<void> {
    await this.#output.write(this.#format(entry, name, await this.#namesFor([entry])));
    this.#written = true;
  }

  async directory(
    path: string,
    heading: string | undefined,
  ): Promise<Array<{ path: string; display: string }>> {
    const entries = this.#context.fileSystem.list(path);
    const identities = await this.#namesFor(entries);
    if (heading !== undefined)
      await this.#output.write(`${this.#written ? "\n" : ""}${heading}:\n`);
    this.#written = true;
    for (const entry of entries)
      await this.#output.write(this.#format(entry, entry.name, identities));
    return entries
      .filter((entry) => entry.kind === "directory")
      .map((entry) => ({ path: entry.path, display: `${heading ?? path}/${entry.name}` }));
  }
}

async function walkDirectories(
  context: ShellCommandContext,
  writer: LsWriter,
  pending: readonly { readonly path: string; readonly display: string }[],
): Promise<void> {
  const queue = [...pending];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) return;
    context.budget.step();
    queue.push(...(await writer.directory(next.path, next.display)));
  }
}

async function listOperand(
  context: ShellCommandContext,
  writer: LsWriter,
  path: string,
  multiple: boolean,
  options: { readonly directory: boolean; readonly long: boolean; readonly recursive: boolean },
): Promise<void> {
  const normalized = commandPath(context, path);
  const entry = context.fileSystem.lstat(normalized);
  const listsThrough =
    !options.directory &&
    (entry.kind === "directory" ||
      (entry.kind === "symlink" && !options.long && linkTargetsDirectory(context, normalized)));
  if (!listsThrough) return await writer.entry(entry, path);
  const heading = options.recursive || multiple ? path : undefined;
  const pending = await writer.directory(normalized, heading);
  if (options.recursive) await walkDirectories(context, writer, pending);
}

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
  const writer = new LsWriter(context, output, long, numeric);
  try {
    for (const path of paths) {
      await listOperand(context, writer, path, paths.length > 1, { directory, long, recursive });
    }
    await output.flush();
  } finally {
    output.abort();
  }
  return 0;
});

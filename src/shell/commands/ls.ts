import { VfsError } from "../../core/errors.js";
import { compareUtf8, dirname } from "../../core/path.js";
import type { VfsStat } from "../../vfs/types.js";
import { identityLabel, type ResolvedIdentityNames, resolveIdentityNames } from "../identity.js";
import type { ShellCommandContext, ShellFileDescriptors } from "../types.js";
import { type AppletSpecWithOptions, defineApplet, parseAppletOptions } from "./applet.js";
import { modeString } from "./format.js";
import { BufferedTextWriter, commandPath, writeText } from "./helpers.js";

const LS = {
  name: "ls",
  usage: "[-adhlnA1R] [PATH...]",
  summary: "lists directory entries or a single path",
  options: {
    short: {
      l: { name: "long" },
      n: { name: "numeric" },
      d: { name: "directory" },
      a: { name: "all" },
      A: { name: "almost-all" },
      h: { name: "human" },
      1: { name: "one-per-line" },
      R: { name: "recursive" },
    },
  },
} as const satisfies AppletSpecWithOptions<
  "long" | "numeric" | "directory" | "all" | "almost-all" | "human" | "one-per-line" | "recursive"
>;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** GNU shows the year instead of the time for anything more than six months old or in the future. */
const RECENT_MS = (365.2425 / 2) * 24 * 60 * 60 * 1000;

/** `Oct 29 17:04`, or `Oct 29  2025` when not recent, in the runtime's fixed UTC zone. */
function listingTime(modifiedAtMs: number, now: number): string {
  const at = new Date(modifiedAtMs);
  const day = `${MONTHS[at.getUTCMonth()]} ${String(at.getUTCDate()).padStart(2)}`;
  const recent = modifiedAtMs <= now && now - modifiedAtMs < RECENT_MS;
  if (!recent) return `${day}  ${at.getUTCFullYear()}`;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${day} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
}

/** GNU `-h`: powers of 1024, rounded up, with one decimal below ten. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return String(bytes);
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < 5) {
    value /= 1024;
    unit += 1;
  }
  const suffix = "KMGTPE"[unit] ?? "E";
  const tenths = Math.ceil(value * 10) / 10;
  return tenths < 10 ? `${tenths.toFixed(1)}${suffix}` : `${Math.ceil(value)}${suffix}`;
}

/** Kibibyte blocks, the unit of `total` and of `du`. */
function blocks(entry: VfsStat): number {
  return entry.kind === "file" ? Math.ceil(entry.sizeBytes / 1024) : 0;
}

interface LsRow {
  readonly entry: VfsStat;
  readonly name: string;
}

interface LsFormat {
  readonly long: boolean;
  readonly numeric: boolean;
  readonly human: boolean;
}

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
  readonly #format: LsFormat;
  readonly #hidden: "none" | "dot-entries" | "all";
  #written = false;

  constructor(
    context: ShellCommandContext,
    output: BufferedTextWriter,
    format: LsFormat,
    hidden: "none" | "dot-entries" | "all",
  ) {
    this.#context = context;
    this.#output = output;
    this.#format = format;
    this.#hidden = hidden;
  }

  async #namesFor(entries: readonly VfsStat[]): Promise<ResolvedIdentityNames | undefined> {
    return this.#format.long && !this.#format.numeric && this.#context.identities !== undefined
      ? await resolveIdentityNames(
          this.#context.identities,
          entries.map((entry) => entry.uid),
          entries.map((entry) => entry.gid),
        )
      : undefined;
  }

  #size(bytes: number): string {
    return this.#format.human ? humanSize(bytes) : String(bytes);
  }

  /** Long rows share column widths, as GNU aligns one listing. */
  #lines(rows: readonly LsRow[], identities: ResolvedIdentityNames | undefined): string[] {
    if (!this.#format.long) return rows.map((row) => `${row.name}\n`);
    const now = this.#context.now();
    const cells = rows.map(({ entry, name }) => ({
      mode: modeString(entry.mode),
      links: String(entry.nlink ?? (entry.kind === "directory" ? 2 : 1)),
      owner: String(
        identities === undefined ? entry.uid : identityLabel(identities.users, entry.uid),
      ),
      group: String(
        identities === undefined ? entry.gid : identityLabel(identities.groups, entry.gid),
      ),
      size: this.#size(entry.sizeBytes),
      time: listingTime(entry.modifiedAtMs, now),
      name: entry.kind === "symlink" ? `${name} -> ${entry.linkTarget}` : name,
    }));
    const width = (key: "links" | "owner" | "group" | "size"): number =>
      Math.max(0, ...cells.map((cell) => cell[key].length));
    const [links, owner, group, size] = [
      width("links"),
      width("owner"),
      width("group"),
      width("size"),
    ];
    return cells.map(
      (cell) =>
        `${cell.mode} ${cell.links.padStart(links)} ${cell.owner.padEnd(owner)} ${cell.group.padEnd(group)} ${cell.size.padStart(size)} ${cell.time} ${cell.name}\n`,
    );
  }

  /** Operands that are not listed through, printed as one aligned block. */
  async entries(rows: readonly LsRow[]): Promise<void> {
    const identities = await this.#namesFor(rows.map((row) => row.entry));
    for (const line of this.#lines(rows, identities)) await this.#output.write(line);
    this.#written = true;
  }

  #rows(path: string): LsRow[] {
    const listed = this.#context.fileSystem.list(path);
    const visible =
      this.#hidden === "none" ? listed.filter((entry) => !entry.name.startsWith(".")) : listed;
    const rows = visible.map((entry) => ({ entry, name: entry.name }));
    if (this.#hidden !== "all") return rows;
    const self = this.#context.fileSystem.stat(path);
    const parent = path === "/" ? self : this.#context.fileSystem.stat(dirname(path));
    return [{ entry: self, name: "." }, { entry: parent, name: ".." }, ...rows];
  }

  async directory(
    path: string,
    heading: string | undefined,
  ): Promise<Array<{ path: string; display: string }>> {
    const rows = this.#rows(path);
    const identities = await this.#namesFor(rows.map((row) => row.entry));
    if (heading !== undefined)
      await this.#output.write(`${this.#written ? "\n" : ""}${heading}:\n`);
    this.#written = true;
    if (this.#format.long) {
      const total = rows.reduce((sum, row) => sum + blocks(row.entry), 0);
      await this.#output.write(`total ${this.#format.human ? humanSize(total * 1024) : total}\n`);
    }
    for (const line of this.#lines(rows, identities)) await this.#output.write(line);
    return rows
      .filter((row) => row.entry.kind === "directory" && row.name !== "." && row.name !== "..")
      .map((row) => ({ path: row.entry.path, display: `${heading ?? path}/${row.name}` }));
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

interface LsOptions {
  readonly directory: boolean;
  readonly long: boolean;
  readonly recursive: boolean;
}

function listsThrough(
  context: ShellCommandContext,
  entry: VfsStat,
  normalized: string,
  options: LsOptions,
): boolean {
  if (options.directory) return false;
  if (entry.kind === "directory") return true;
  return entry.kind === "symlink" && !options.long && linkTargetsDirectory(context, normalized);
}

function lstatOperand(context: ShellCommandContext, normalized: string): VfsStat | undefined {
  try {
    return context.fileSystem.lstat(normalized);
  } catch (error) {
    if (error instanceof VfsError && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * GNU prints file operands first, sorted and aligned together, then each
 * directory. A missing operand is reported and skipped, and makes the status 2.
 */
async function listOperands(
  context: ShellCommandContext,
  writer: LsWriter,
  paths: readonly string[],
  options: LsOptions,
  stderr: ShellFileDescriptors[2],
): Promise<number> {
  const files: LsRow[] = [];
  const directories: Array<{ readonly path: string; readonly normalized: string }> = [];
  let status = 0;
  for (const path of [...paths].sort(compareUtf8)) {
    const normalized = commandPath(context, path);
    const entry = lstatOperand(context, normalized);
    if (entry === undefined) {
      await writeText(stderr, `ls: cannot access '${path}': No such file or directory\n`);
      status = 2;
    } else if (listsThrough(context, entry, normalized, options)) {
      directories.push({ path, normalized });
    } else files.push({ entry, name: path });
  }
  if (files.length > 0) await writer.entries(files);
  for (const { path, normalized } of directories) {
    const heading = options.recursive || paths.length > 1 ? path : undefined;
    const pending = await writer.directory(normalized, heading);
    if (options.recursive) await walkDirectories(context, writer, pending);
  }
  return status;
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
  const has = (name: string): boolean => parsed.options.some((option) => option.name === name);
  const numeric = has("numeric");
  const long = numeric || has("long");
  const directory = has("directory");
  const recursive = has("recursive");
  const hidden = has("all") ? "all" : has("almost-all") ? "dot-entries" : "none";
  const paths = parsed.operands.length === 0 ? ["."] : parsed.operands;
  const output = new BufferedTextWriter(context, fds[1]);
  const writer = new LsWriter(context, output, { long, numeric, human: has("human") }, hidden);
  try {
    const status = await listOperands(
      context,
      writer,
      paths,
      { directory, long, recursive },
      fds[2],
    );
    await output.flush();
    return status;
  } finally {
    output.abort();
  }
});

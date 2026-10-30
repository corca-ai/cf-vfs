import { VfsError } from "../../core/errors.js";
import type { EntryPage, VfsStat } from "../../vfs/types.js";
import type { ShellCommandContext } from "../types.js";
import { commandPath, displayPath } from "./helpers.js";
import { openInput } from "./inputs.js";
import { ReadAhead } from "./read-ahead.js";

/**
 * One entry of a recursive walk: an openable stream, or the reason it is not.
 *
 * Only the walk produces the failing member. A named operand that cannot be
 * opened is the caller's own error and still throws; an unreadable file found
 * partway through a subtree is not, and stopping the walk there would throw
 * away every match already reported.
 */
export type CommandInput =
  | {
      readonly name: string;
      readonly stream: ReadableStream<Uint8Array>;
      readonly chunks?: undefined;
      readonly error?: undefined;
    }
  | {
      /** A file body read in bulk: the chunks its stream would have yielded. */
      readonly name: string;
      readonly chunks: readonly Uint8Array[];
      readonly stream?: undefined;
      readonly error?: undefined;
    }
  | {
      readonly name: string;
      readonly stream?: undefined;
      readonly chunks?: undefined;
      readonly error: VfsError;
    };

/** Decides from a walked file's displayed path whether to open it. */
export type RecursiveFilter = (name: string) => boolean;

interface WalkedFile {
  readonly name: string;
  readonly entry: VfsStat;
}

/**
 * Takes walked files from `at` whose inline bodies fit in `bytes` together,
 * stopping at the first that does not, so files stay in walk order.
 */
function bulkGroup(files: readonly WalkedFile[], at: number, bytes: number): WalkedFile[] {
  const group: WalkedFile[] = [];
  let total = 0;
  for (let index = at; index < files.length; index += 1) {
    const file = files[index] as WalkedFile;
    const size = file.entry.contentClass === "inline" ? file.entry.sizeBytes : bytes + 1;
    if (total + size > bytes) break;
    group.push(file);
    total += size;
  }
  return group;
}

async function* walkedInputs(
  context: ShellCommandContext,
  files: readonly WalkedFile[],
): AsyncGenerator<CommandInput> {
  const ahead = new ReadAhead(context);
  try {
    let at = 0;
    while (at < files.length) {
      const group = bulkGroup(files, at, ahead.allowance());
      if (group.length < 2) {
        yield await openWalked(context, files[at] as WalkedFile);
        at += 1;
        continue;
      }
      ahead.fill(group.map((file) => file.entry.path));
      for (const file of group) {
        const read = ahead.take(file.entry.path);
        // Anything not read in bulk, or changed since, takes the ordinary path.
        yield read === undefined
          ? await openWalked(context, file)
          : { name: file.name, chunks: read.chunks };
      }
      at += group.length;
    }
  } finally {
    ahead.release();
  }
}

async function openWalked(context: ShellCommandContext, file: WalkedFile): Promise<CommandInput> {
  try {
    return { name: file.name, stream: await openInput(context, file.entry.path) };
  } catch (error) {
    return {
      name: file.name,
      error:
        error instanceof VfsError ? error : new VfsError("EIO", "read failed", file.entry.path),
    };
  }
}

/**
 * Walks a directory operand page by page. Each page's accepted files are read
 * ahead in bulk where the filesystem offers it: two statements per batch of
 * bodies instead of a call and a stream per file, which is what dominates a
 * large walk on Workers. See {@link ReadAhead} for why that changes nothing.
 */
async function* recursiveDirectoryInputs(
  context: ShellCommandContext,
  operand: string,
  root: string,
  accept: RecursiveFilter,
): AsyncGenerator<CommandInput> {
  let cursor: string | null = null;
  do {
    context.budget.step();
    const page: EntryPage = context.fileSystem.findPage({
      path: root,
      type: "file",
      ...(cursor === null ? {} : { cursor }),
    });
    // The walk streams pages rather than holding matches, so it charges
    // expansion work instead of the per-result match limit.
    context.budget.expansionWork(page.scanned);
    const files = page.entries.flatMap((entry) => {
      const name = displayPath(operand, root, entry.path);
      return accept(name) ? [{ name, entry }] : [];
    });
    yield* walkedInputs(context, files);
    cursor = page.nextCursor;
  } while (cursor !== null);
}

/**
 * Walks the file operands of a recursive command.
 *
 * A directory expands through `findPage`, so a large subtree costs a bounded
 * number of indexed queries and never materializes the whole namespace. Each
 * page charges the shared glob budget, which is what bounds the walk, and a
 * non-directory operand is yielded as itself so `grep -r file` still works.
 */
export async function* recursiveInputs(
  context: ShellCommandContext,
  paths: readonly string[],
  accept: RecursiveFilter = () => true,
): AsyncGenerator<CommandInput> {
  // With no operand the walk starts at the working directory but reports bare
  // relative paths, as `grep -r` does — an explicit `.` is what prints `./`.
  for (const path of paths.length === 0 ? [""] : paths) {
    const normalized = commandPath(context, path === "" ? "." : path);
    const stat = context.fileSystem.stat(normalized);
    if (stat.kind !== "directory") {
      yield { name: path, stream: await openInput(context, normalized) };
      continue;
    }
    const root = context.fileSystem.realpath(normalized);
    yield* recursiveDirectoryInputs(context, path, root, accept);
  }
}

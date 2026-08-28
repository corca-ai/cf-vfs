import { VfsError } from "../core/errors.js";
import { normalizePath } from "../core/path.js";
import { bodyToStream } from "../vfs/streams.js";
import type { ByteBody } from "../vfs/types.js";
import type { OpaqueContentAccess, ShellContentReader } from "./content.js";
import { openContent } from "./content.js";
import { deviceInput, deviceSink, shellDevice } from "./devices.js";
import { type ExpansionRuntime, expandScalarWord, expandWord } from "./expand.js";
import { shellInput } from "./input.js";
import type { Redirection } from "./parser.js";
import { sinkFromWritable } from "./pipe.js";
import type {
  ShellBudget,
  ShellFileDescriptors,
  ShellFileSystem,
  ShellSession,
  ShellSink,
} from "./types.js";

function atomicFileSink(
  fileSystem: ShellFileSystem,
  path: string,
  append: boolean,
  maximumBytes: number,
  budget: ShellBudget,
): ShellSink {
  const stat = fileSystem.inspectWriteTarget(path);
  const mutationToken =
    stat?.path === path ? stat.mutationToken : fileSystem.getMutationToken(path);
  const exists = stat !== null;
  if (stat !== null) {
    if (stat.kind === "directory") throw new VfsError("EISDIR", "is a directory", path);
    if (append && stat.contentClass === "opaque") {
      throw new VfsError("ENOTSUP", "cannot append to opaque R2 content", path);
    }
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let release: () => void = () => undefined;
  let aborted = false;
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      total += chunk.byteLength;
      if (total > maximumBytes) {
        throw new VfsError("EFBIG", `redirection exceeds the ${maximumBytes}-byte limit`, path);
      }
      release();
      release = budget.buffered(total);
      chunks.push(chunk);
    },
    async close() {
      if (aborted) return;
      const single = chunks[0];
      const body: ByteBody =
        chunks.length <= 1
          ? (single ?? new Uint8Array(0))
          : new ReadableStream<Uint8Array>({
              start(controller) {
                for (const chunk of chunks) controller.enqueue(chunk);
                controller.close();
              },
            });
      try {
        if (append && exists) {
          await fileSystem.appendFile(path, body, { ifMutationToken: mutationToken });
        } else {
          await fileSystem.writeFile(path, body, {
            ifMutationToken: mutationToken,
            disposition: exists ? "replace" : "create",
          });
        }
      } finally {
        chunks.length = 0;
        release();
      }
    },
    abort() {
      aborted = true;
      release();
      chunks.length = 0;
    },
  });
  return sinkFromWritable(writable);
}

async function targetPath(
  target: import("./parser.js").ShellWord,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  runtime: ExpansionRuntime,
): Promise<string> {
  const values = await expandWord(target, session, fileSystem, budget, runtime);
  if (values.length !== 1 || values[0] === undefined) {
    throw new VfsError("EINVAL", "ambiguous redirection target");
  }
  return normalizePath(values[0], session.cwd);
}

export interface AppliedRedirections {
  fds: ShellFileDescriptors;
  redirected: ReadonlySet<1 | 2>;
  inputRedirected: boolean;
}

export async function applyRedirections(
  redirections: readonly Redirection[],
  initial: ShellFileDescriptors,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  cancelReplacedInput: boolean,
  runtime: ExpansionRuntime,
  /** What a `<` may open: the same rule a command operand goes through. */
  input: {
    readonly content?: ShellContentReader | undefined;
    readonly access?: OpaqueContentAccess | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<AppliedRedirections> {
  const fds: ShellFileDescriptors = { 0: initial[0], 1: initial[1], 2: initial[2] };
  const redirected = new Set<1 | 2>();
  let inputRedirected = false;
  try {
    for (const redirection of redirections) {
      if (redirection.operator === "2>&1") {
        await fds[2].close();
        fds[2] = fds[1].clone();
        if (redirected.has(1)) redirected.add(2);
        else redirected.delete(2);
        continue;
      }
      // The mirror of `2>&1`, and implemented as one: both descriptors exist,
      // so duplicating either way is the same three lines. The duplicate stays
      // out of `redirected` for the reason `2>&1`'s does — aborting it would
      // tear down the stream it was duplicated from.
      if (redirection.operator === ">&2") {
        await fds[1].close();
        fds[1] = fds[2].clone();
        if (redirected.has(2)) redirected.add(1);
        else redirected.delete(1);
        continue;
      }
      if (redirection.operator === "<<<") {
        const value = await expandScalarWord(
          redirection.target,
          session,
          fileSystem,
          budget,
          runtime,
        );
        if (cancelReplacedInput || inputRedirected) {
          await fds[0].cancel(new VfsError("EPIPE", "pipeline input was replaced by redirection"));
        }
        fds[0] = shellInput(bodyToStream(`${value}\n`));
        inputRedirected = true;
        continue;
      }
      if ("document" in redirection) {
        const value = await expandScalarWord(
          redirection.document,
          session,
          fileSystem,
          budget,
          runtime,
        );
        if (cancelReplacedInput || inputRedirected) {
          await fds[0].cancel(new VfsError("EPIPE", "pipeline input was replaced by redirection"));
        }
        fds[0] = shellInput(bodyToStream(value));
        inputRedirected = true;
        continue;
      }
      const path = await targetPath(redirection.target, session, fileSystem, budget, runtime);
      const device = shellDevice(path);
      // A device is a path like any other as far as the declared roots are
      // concerned, so the roots are checked before the descriptor layer
      // answers. Going straight to the device would be the accidental bypass.
      if (device !== undefined) {
        if (redirection.operator === "<") fileSystem.assertReadable(path);
        else fileSystem.assertWritable(path);
      }
      if (redirection.operator === "<") {
        // `< /dev/stdin` names the input it would replace, so it changes
        // nothing. Going through the motions would cancel the stream first and
        // then hand back what was just cancelled.
        if (device === "stdin") continue;
        const replacement =
          device === undefined
            ? (
                await openContent(fileSystem, path, {
                  reader: input.content,
                  access: input.access,
                  signal: input.signal,
                })
              ).stream
            : deviceInput(device, fds, path);
        if (cancelReplacedInput || inputRedirected) {
          await fds[0].cancel(new VfsError("EPIPE", "pipeline input was replaced by redirection"));
        }
        fds[0] = shellInput(replacement);
        inputRedirected = true;
        continue;
      }
      const descriptor = redirection.operator.startsWith("2") ? 2 : 1;
      // The sink is built before the descriptor it replaces is closed, so a
      // constructor that throws leaves the current descriptor intact. A device
      // alias needs the same ordering for its own reason: `> /dev/stdout`
      // takes its reference while the original is still open.
      const replacement =
        device === undefined
          ? atomicFileSink(
              fileSystem,
              path,
              redirection.operator.endsWith(">>"),
              budget.limits.maxPipelineBytes,
              budget,
            )
          : deviceSink(device, fds, path);
      try {
        await fds[descriptor].close();
      } catch (error) {
        await replacement.abort(error).catch(() => undefined);
        throw error;
      }
      fds[descriptor] = replacement;
      redirected.add(descriptor);
    }
    return { fds, redirected, inputRedirected };
  } catch (error) {
    await Promise.allSettled([
      fds[0] === initial[0] ? Promise.resolve() : fds[0].cancel(error),
      redirected.has(1) ? fds[1].abort(error) : fds[1].close(),
      redirected.has(2) ? fds[2].abort(error) : fds[2].close(),
    ]);
    throw error;
  }
}

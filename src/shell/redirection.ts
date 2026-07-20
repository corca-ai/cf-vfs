import { VfsError } from "../core/errors.js";
import { normalizePath } from "../core/path.js";
import type { ByteBody } from "../vfs/types.js";
import { expandWord } from "./expand.js";
import { sinkFromWritable } from "./pipe.js";
import type { Redirection } from "./parser.js";
import type {
  ShellBudget,
  ShellFileSystem,
  ShellFileDescriptors,
  ShellSession,
  ShellSink,
} from "./types.js";

async function atomicFileSink(
  fileSystem: ShellFileSystem,
  path: string,
  append: boolean,
  maximumBytes: number,
  budget: ShellBudget,
): Promise<ShellSink> {
  const stat = await fileSystem.inspectWriteTarget(path);
  const mutationToken = await fileSystem.getMutationToken(path);
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
      chunks.push(chunk.slice());
    },
    async close() {
      if (aborted) return;
      const body: ByteBody = new ReadableStream<Uint8Array>({
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
  redirection: Redirection,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
): Promise<string> {
  if (redirection.target === undefined) throw new VfsError("EINVAL", "missing redirection target");
  const values = await expandWord(redirection.target, session, fileSystem, budget);
  if (values.length !== 1 || values[0] === undefined) {
    throw new VfsError("EINVAL", "ambiguous redirection target");
  }
  return normalizePath(values[0], session.cwd);
}

export async function applyRedirections(
  redirections: readonly Redirection[],
  initial: ShellFileDescriptors,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  cancelReplacedInput: boolean,
): Promise<{
  fds: ShellFileDescriptors;
  redirected: ReadonlySet<1 | 2>;
  inputRedirected: boolean;
}> {
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
      const path = await targetPath(redirection, session, fileSystem, budget);
      if (redirection.operator === "<") {
        const replacement = (await fileSystem.readFile(path)).stream;
        if (cancelReplacedInput || inputRedirected) {
          await fds[0].cancel(new VfsError("EPIPE", "pipeline input was replaced by redirection"));
        }
        fds[0] = replacement;
        inputRedirected = true;
        continue;
      }
      const descriptor = redirection.operator.startsWith("2") ? 2 : 1;
      const replacement = await atomicFileSink(
        fileSystem,
        path,
        redirection.operator.endsWith(">>"),
        budget.limits.maxPipelineBytes,
        budget,
      );
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

import { VfsError } from "../core/errors.js";
import { normalizePath } from "../core/path.js";
import { bodyToStream } from "../vfs/streams.js";
import type { ByteBody } from "../vfs/types.js";
import type { OpaqueContentAccess, ShellContentReader } from "./content.js";
import { openContent } from "./content.js";
import { deviceInput, deviceSink, shellDevice } from "./devices.js";
import { type ExpansionRuntime, expandScalarWord, expandWord } from "./expand.js";
import { shellInput } from "./input.js";
import type { Redirection, ShellWord } from "./parser.js";
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

interface RedirectionInput {
  readonly content?: ShellContentReader | undefined;
  readonly access?: OpaqueContentAccess | undefined;
  readonly signal?: AbortSignal | undefined;
}

class RedirectionState {
  readonly fds: ShellFileDescriptors;
  readonly redirected = new Set<1 | 2>();
  #inputRedirected = false;

  constructor(
    initial: ShellFileDescriptors,
    readonly session: ShellSession,
    readonly fileSystem: ShellFileSystem,
    readonly budget: ShellBudget,
    readonly cancelReplacedInput: boolean,
    readonly runtime: ExpansionRuntime,
    readonly input: RedirectionInput,
  ) {
    this.fds = { 0: initial[0], 1: initial[1], 2: initial[2] };
  }

  get inputRedirected(): boolean {
    return this.#inputRedirected;
  }

  async #duplicate(from: 1 | 2, to: 1 | 2): Promise<void> {
    await this.fds[to].close();
    this.fds[to] = this.fds[from].clone();
    if (this.redirected.has(from)) this.redirected.add(to);
    else this.redirected.delete(to);
  }

  async #replaceInput(stream: ReadableStream<Uint8Array>): Promise<void> {
    if (this.cancelReplacedInput || this.#inputRedirected) {
      await this.fds[0].cancel(new VfsError("EPIPE", "pipeline input was replaced by redirection"));
    }
    this.fds[0] = shellInput(stream);
    this.#inputRedirected = true;
  }

  async #scalarInput(word: ShellWord, newline: boolean): Promise<void> {
    const value = await expandScalarWord(
      word,
      this.session,
      this.fileSystem,
      this.budget,
      this.runtime,
    );
    await this.#replaceInput(bodyToStream(newline ? `${value}\n` : value));
  }

  async #pathInput(path: string, device: ReturnType<typeof shellDevice>): Promise<void> {
    if (device === "stdin") return;
    const replacement =
      device === undefined
        ? (
            await openContent(this.fileSystem, path, {
              reader: this.input.content,
              access: this.input.access,
              signal: this.input.signal,
            })
          ).stream
        : deviceInput(device, this.fds, path);
    await this.#replaceInput(replacement);
  }

  async #bothOutputs(replacement: ShellSink): Promise<void> {
    const errorReplacement = replacement.clone();
    try {
      await Promise.all([this.fds[1].close(), this.fds[2].close()]);
    } catch (error) {
      await replacement.abort(error).catch(() => undefined);
      throw error;
    }
    this.fds[1] = replacement;
    this.fds[2] = errorReplacement;
    this.redirected.add(1);
    this.redirected.add(2);
  }

  async #oneOutput(replacement: ShellSink, descriptor: 1 | 2): Promise<void> {
    try {
      await this.fds[descriptor].close();
    } catch (error) {
      await replacement.abort(error).catch(() => undefined);
      throw error;
    }
    this.fds[descriptor] = replacement;
    this.redirected.add(descriptor);
  }

  async #pathOutput(
    path: string,
    device: ReturnType<typeof shellDevice>,
    operator: Redirection["operator"],
  ): Promise<void> {
    const replacement =
      device === undefined
        ? atomicFileSink(
            this.fileSystem,
            path,
            operator.endsWith(">>"),
            this.budget.limits.maxPipelineBytes,
            this.budget,
          )
        : deviceSink(device, this.fds, path);
    if (operator === "&>" || operator === "&>>") return await this.#bothOutputs(replacement);
    await this.#oneOutput(replacement, operator.startsWith("2") ? 2 : 1);
  }

  async apply(redirection: Redirection): Promise<void> {
    if (redirection.operator === "2>&1") return await this.#duplicate(1, 2);
    if (redirection.operator === ">&2") return await this.#duplicate(2, 1);
    if (redirection.operator === "<<<") return await this.#scalarInput(redirection.target, true);
    if ("document" in redirection) return await this.#scalarInput(redirection.document, false);
    const path = await targetPath(
      redirection.target,
      this.session,
      this.fileSystem,
      this.budget,
      this.runtime,
    );
    const device = shellDevice(path);
    if (device !== undefined) {
      if (redirection.operator === "<") this.fileSystem.assertReadable(path);
      else this.fileSystem.assertWritable(path);
    }
    return redirection.operator === "<"
      ? await this.#pathInput(path, device)
      : await this.#pathOutput(path, device, redirection.operator);
  }
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
  input: RedirectionInput = {},
): Promise<AppliedRedirections> {
  const state = new RedirectionState(
    initial,
    session,
    fileSystem,
    budget,
    cancelReplacedInput,
    runtime,
    input,
  );
  try {
    for (const redirection of redirections) await state.apply(redirection);
    return {
      fds: state.fds,
      redirected: state.redirected,
      inputRedirected: state.inputRedirected,
    };
  } catch (error) {
    await Promise.allSettled([
      state.fds[0] === initial[0] ? Promise.resolve() : state.fds[0].cancel(error),
      state.redirected.has(1) ? state.fds[1].abort(error) : state.fds[1].close(),
      state.redirected.has(2) ? state.fds[2].abort(error) : state.fds[2].close(),
    ]);
    throw error;
  }
}

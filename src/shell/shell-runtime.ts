import { isVfsError, VfsError } from "../core/errors.js";
import { encodeUtf8, utf8ByteLength } from "../core/unicode.js";
import type { AppletRegistry } from "./commands/applet.js";
import type { ShellContentReader } from "./content.js";
import { ShellNounsetError, ShellRefusalError } from "./errors.js";
import type { ShellEventSink } from "./events.js";
import type { ExpansionRuntime } from "./expand.js";
import type { ShellIdentitySource } from "./identity.js";
import type { ShellNetwork } from "./network.js";
import { type CommandNode, parseShellScript, type ScriptNode } from "./parser.js";
import { createBytePipe } from "./pipe.js";
import { cloneShellSession } from "./session.js";
import type {
  ShellBudget,
  ShellFileDescriptors,
  ShellFileSystem,
  ShellLimits,
  ShellPolicy,
  ShellSession,
  ShellSink,
} from "./types.js";

type ScriptRunner = (
  script: ScriptNode,
  session: ShellSession,
  fds: ShellFileDescriptors,
  runtime: Runtime,
  context: EvaluationContext,
) => Promise<EvaluationResult>;

type CommandNodeRunner = (
  node: CommandNode,
  session: ShellSession,
  fds: ShellFileDescriptors,
  runtime: Runtime,
  cancelUnreadInput: boolean,
  context: EvaluationContext,
) => Promise<EvaluationResult>;

export function emptyInput(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

export function statusFor(error: VfsError): number {
  return error instanceof ShellNounsetError
    ? 1
    : error.code === "EINVAL"
      ? 2
      : error instanceof ShellRefusalError || error.code === "ENOEXEC"
        ? 126
        : 1;
}

export function formatError(error: VfsError): string {
  return `${error.path === undefined ? "" : `${error.path}: `}${error.message}`;
}

export async function runIsolatedShellScope(
  run: () => Promise<EvaluationResult>,
  stderr: ShellSink,
): Promise<EvaluationResult> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ShellNounsetError)) throw error;
    await stderr.write(encodeUtf8(`${formatError(error)}\n`));
    return evaluationResult(statusFor(error));
  }
}

export async function closeDescriptors(fds: ShellFileDescriptors): Promise<void> {
  const results = await Promise.allSettled([fds[1].close(), fds[2].close()]);
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed !== undefined) throw failed.reason;
}

export async function abortRedirectedDescriptors(
  fds: ShellFileDescriptors,
  redirected: ReadonlySet<1 | 2>,
  reason: unknown,
): Promise<void> {
  await Promise.allSettled([
    redirected.has(1) ? fds[1].abort(reason) : fds[1].close(),
    redirected.has(2) ? fds[2].abort(reason) : fds[2].close(),
  ]);
}

export interface Runtime {
  commands: AppletRegistry;
  pathLookup: boolean;
  now: () => number;
  fileSystem: ShellFileSystem;
  content: ShellContentReader | undefined;
  network: ShellNetwork | undefined;
  identities: ShellIdentitySource | undefined;
  budget: ShellBudget;
  policy: ShellPolicy;
  signal: AbortSignal;
  limits: ShellLimits;
  parserBudget: ParserBudget;
  onEvent: ShellEventSink | undefined;
  runScript: ScriptRunner;
  runCommandNode: CommandNodeRunner;
}

export interface EvaluationContext {
  readonly errexitSuppressed: boolean;
}

export interface EvaluationResult {
  readonly status: number;
  readonly errexitEligible: boolean;
}

export const ACTIVE_EVALUATION_CONTEXT: EvaluationContext = Object.freeze({
  errexitSuppressed: false,
});
export const SUPPRESSED_EVALUATION_CONTEXT: EvaluationContext = Object.freeze({
  errexitSuppressed: true,
});

export function suppressErrexit(context: EvaluationContext): EvaluationContext {
  return context.errexitSuppressed ? context : SUPPRESSED_EVALUATION_CONTEXT;
}

export function evaluationResult(status: number, errexitEligible = true): EvaluationResult {
  return { status, errexitEligible };
}

export function requestErrexit(
  status: number,
  session: ShellSession,
  context: EvaluationContext,
): void {
  if (
    status !== 0 &&
    session.errexit === true &&
    !context.errexitSuppressed &&
    !session.exitRequested &&
    session.flow.type === "none"
  ) {
    session.flow = { type: "errexit" };
  }
}

export interface ParserBudget {
  sourceBytes: number;
  astNodes: number;
}

export function parseScriptUnit(
  source: string,
  limits: ShellLimits,
  budget: ParserBudget,
  executionBudget: Pick<ShellBudget, "checkDeadline">,
  path?: string,
): ScriptNode {
  const sourceBytes = utf8ByteLength(source);
  if (sourceBytes > limits.maxScriptBytes) {
    throw new VfsError("E2BIG", "shell source exceeds the script byte limit", path);
  }
  if (budget.sourceBytes + sourceBytes > limits.maxTotalSourceBytes) {
    throw new VfsError("E2BIG", "shell total source byte limit exceeded", path);
  }
  budget.sourceBytes += sourceBytes;
  try {
    const parsed = parseShellScript(
      source,
      limits.maxAstNodes - budget.astNodes,
      limits.maxNestingDepth,
      (count) => {
        budget.astNodes += count;
      },
      () => executionBudget.checkDeadline(),
    );
    return parsed;
  } catch (error) {
    if (path === undefined || !isVfsError(error)) throw error;
    throw new VfsError(error.code, error.message, path);
  }
}

interface CollectedSubstitution {
  bytes: Uint8Array;
  release(): void;
}

async function collectSubstitutionOutput(
  stream: ReadableStream<Uint8Array>,
  runtime: Runtime,
): Promise<CollectedSubstitution> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  const chunkReleases: Array<() => void> = [];
  let total = 0;
  let releaseOutput: (() => void) | undefined;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > runtime.limits.maxCommandSubstitutionBytes) {
        throw new VfsError("E2BIG", "command substitution output limit exceeded");
      }
      const release = runtime.budget.buffered(result.value.byteLength);
      try {
        chunks.push(result.value.slice());
        chunkReleases.push(release);
      } catch (error) {
        release();
        throw error;
      }
    }
    releaseOutput = runtime.budget.buffered(total);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    chunks.length = 0;
    for (const release of chunkReleases.splice(0)) release();
    return { bytes, release: releaseOutput };
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    releaseOutput?.();
    throw error;
  } finally {
    for (const release of chunkReleases) release();
    reader.releaseLock();
  }
}

export function redirections(node: CommandNode): readonly import("./parser.js").Redirection[] {
  return node.type === "function-definition" ? [] : node.redirections;
}

export function expansionRuntime(fds: ShellFileDescriptors, runtime: Runtime): ExpansionRuntime {
  let lastStatus: number | undefined;
  return {
    async commandSubstitute(script, session) {
      const output = createBytePipe({
        maximumBytes: runtime.limits.maxCommandSubstitutionBytes,
        signal: runtime.signal,
        name: "command substitution",
        account: (bytes) => runtime.budget.io(bytes),
      });
      const child = cloneShellSession(session);
      child.errexit = false;
      const childFds: ShellFileDescriptors = {
        0: fds[0],
        1: output.sink,
        2: fds[2].clone(),
      };
      const completed = (async () => {
        try {
          return await runIsolatedShellScope(
            async () =>
              await runtime.runScript(script, child, childFds, runtime, ACTIVE_EVALUATION_CONTEXT),
            fds[2],
          );
        } finally {
          await closeDescriptors(childFds);
        }
      })();
      let retained: CollectedSubstitution | undefined;
      try {
        const [collected, result] = await Promise.all([
          collectSubstitutionOutput(output.readable, runtime).then((value) => {
            retained = value;
            return value;
          }),
          completed,
        ]);
        lastStatus = result.status;
        let value: string;
        try {
          value = new TextDecoder("utf-8", { fatal: true }).decode(collected.bytes);
        } catch {
          throw new VfsError("EIO", "command substitution output is not valid UTF-8");
        }
        if (value.includes("\0"))
          throw new VfsError("EINVAL", "command substitution produced a NUL byte");
        return value.replace(/\n+$/u, "");
      } finally {
        retained?.release();
      }
    },
    lastSubstitutionStatus() {
      return lastStatus;
    },
  };
}

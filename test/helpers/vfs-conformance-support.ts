import { it } from "vitest";
import { readAllBytes } from "../../src/vfs/streams.js";
import type { VirtualFileSystem } from "../../src/vfs/types.js";

// Durable Object RPC turns synchronous server results into promises at the caller boundary.
export type RpcCompatibleVirtualFileSystem = {
  [Method in keyof VirtualFileSystem]: VirtualFileSystem[Method] extends (
    ...args: infer Args
  ) => infer Result
    ? (...args: Args) => Result | Promise<Awaited<Result>>
    : never;
};

export type VfsFactory = () =>
  | RpcCompatibleVirtualFileSystem
  | Promise<RpcCompatibleVirtualFileSystem>;

export async function readText(
  fileSystem: RpcCompatibleVirtualFileSystem,
  path: string,
): Promise<string> {
  return new TextDecoder().decode(
    await readAllBytes((await fileSystem.readFile(path)).stream, 1024),
  );
}

export function gatedBody(value: string): {
  readonly stream: ReadableStream<Uint8Array>;
  readonly pulled: Promise<void>;
  close(): void;
} {
  let release: (() => void) | undefined;
  let markPulled: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pulled = new Promise<void>((resolve) => {
    markPulled = resolve;
  });
  let sent = false;
  return {
    stream: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode(value));
          markPulled?.();
          return;
        }
        return closed.then(() => controller.close());
      },
    }),
    pulled,
    close() {
      release?.();
    },
  };
}

export function streamThatFailsAfter(value: string): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode(value));
        return;
      }
      controller.error(new Error("source failed"));
    },
  });
}

/**
 * The error a call refused with, or null if it did not refuse.
 *
 * The rejection handler is attached where the promise is created rather than
 * through `expect().rejects`, which the Durable Object backend needs: the RPC
 * stub reports an unconsumed rejection as an unhandled error even when the
 * assertion itself passes.
 */
export async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => null,
    (error: unknown) => error,
  );
}

export interface VfsConformanceOptions {
  readonly negativeMutationRaces?: boolean;
  readonly failedInputStreams?: boolean;
}

export type VfsConformanceCase = (factory: VfsFactory, options: VfsConformanceOptions) => void;

export function conformanceCase(
  name: string,
  run: (factory: VfsFactory, options: VfsConformanceOptions) => unknown,
): VfsConformanceCase {
  return (factory, options) => it(name, () => run(factory, options));
}

export function optionalConformanceCase(
  option: keyof VfsConformanceOptions,
  name: string,
  run: (factory: VfsFactory, options: VfsConformanceOptions) => unknown,
): VfsConformanceCase {
  return (factory, options) => {
    if (options[option] !== false) it(name, () => run(factory, options));
  };
}

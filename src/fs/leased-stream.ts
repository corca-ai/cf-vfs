import { isVfsError, VfsError } from "../core/errors.js";

function readFailure(error: unknown, path: string): VfsError {
  return isVfsError(error) ? error : new VfsError("EIO", "opaque content read failed", path);
}

function checkSize(read: number, expected: number, path: string, complete = false): void {
  if (read > expected || (complete && read !== expected)) {
    throw new VfsError("EIO", "opaque body size does not match metadata", path);
  }
}

export function leasedStream(
  body: ReadableStream<Uint8Array>,
  path: string,
  expires: number,
  expected: number,
  now: () => number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let read = 0;
  let settled = false;
  const checkLease = () => {
    if (now() >= expires) throw new VfsError("EIO", "opaque read lease expired", path);
  };
  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      if (settled) return;
      try {
        checkLease();
        const next = await reader.read();
        if (settled) return;
        checkLease();
        if (next.done) {
          checkSize(read, expected, path, true);
          settled = true;
          reader.releaseLock();
          controller.close();
          return;
        }
        read += next.value.byteLength;
        checkSize(read, expected, path);
        controller.enqueue(next.value);
      } catch (error) {
        if (settled) return;
        settled = true;
        await reader.cancel(error).catch(() => undefined);
        reader.releaseLock();
        controller.error(readFailure(error, path));
      }
    },
    cancel: async (reason) => {
      settled = true;
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

import type { ShellSink } from "./types.js";

/**
 * A sink that discards everything written to it.
 *
 * Nothing is buffered, no chunk is retained, and nothing is charged: the bytes
 * were already metered when whatever produced them read or generated them, and
 * charging again would make `cmd > /dev/null` fail budgets that `cmd > file`
 * passes. `close` and `abort` do nothing because there is nothing to publish or
 * undo, which is also what makes it safe to hand the same sink to two
 * descriptors.
 */
export function nullSink(): ShellSink {
  const sink: ShellSink = {
    async write(): Promise<void> {},
    async close(): Promise<void> {},
    async abort(): Promise<void> {},
    clone: () => sink,
  };
  return sink;
}

/**
 * A duplicate that can release its own reference but never destroy the stream.
 *
 * `abort` on a shared sink tears down the underlying stream for every holder,
 * which is right for a file being abandoned and catastrophic for a duplicate:
 * a redirection that fails after `> /dev/stdout` was applied would abort the
 * execution's own standard output and discard everything already written to
 * it. `2>&1` avoids this by keeping its duplicate out of the aborted set; a
 * duplicate that closes instead of aborting is safe wherever it is held.
 */
export function aliasSink(inner: ShellSink): ShellSink {
  return {
    write: (chunk) => inner.write(chunk),
    close: () => inner.close(),
    abort: () => inner.close(),
    clone: () => aliasSink(inner.clone()),
  };
}

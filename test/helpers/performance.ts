import { defaultShellCommands } from "../../src/shell/commands/default.js";
import { Shell } from "../../src/shell/shell.js";
import type { NodeSqlFileSystem, NodeSqlFileSystemOptions } from "../../src/testing/node.js";
import { MemoryOpaqueStore } from "../../src/testing/opaque-store.js";
import { putOpaque } from "../../src/vfs/opaque.js";
import type { OpaqueStore } from "../../src/vfs/types.js";
import { createTestFileSystem } from "./node-sql.js";

/**
 * Structural performance guards.
 *
 * These assert counted work — SQL statements, returned rows, and output chunks
 * — rather than elapsed time, so a regression is a deterministic failure in
 * `npm run check` instead of a noisy number in a benchmark report. Wall-clock
 * scenarios stay in `bench/`.
 *
 * Every upper bound is paired with a lower bound. An assertion that only caps
 * counted work is satisfied by zero, so a meter that silently stopped observing
 * would leave the whole gate green while measuring nothing.
 */

export interface SqlMeter {
  statements: number;
  rows: number;
  reset(): void;
}

export function meteredFileSystem(options: Omit<NodeSqlFileSystemOptions, "onStatement"> = {}): {
  fileSystem: NodeSqlFileSystem;
  meter: SqlMeter;
} {
  const meter: SqlMeter = {
    statements: 0,
    rows: 0,
    reset() {
      meter.statements = 0;
      meter.rows = 0;
    },
  };
  const fileSystem = createTestFileSystem({
    ...options,
    onStatement: (_query, rows) => {
      meter.statements += 1;
      meter.rows += rows;
    },
  });
  return { fileSystem, meter };
}

export async function garbageStatements(
  count: number,
  options: { expireUploads?: boolean; failDelete?: boolean } = {},
): Promise<number> {
  let now = 0;
  const meter: SqlMeter = {
    statements: 0,
    rows: 0,
    reset() {
      meter.statements = 0;
      meter.rows = 0;
    },
  };
  const backing = new MemoryOpaqueStore();
  const store: OpaqueStore =
    options.failDelete === true
      ? {
          putIfAbsent: (...args) => backing.putIfAbsent(...args),
          head: (...args) => backing.head(...args),
          getStream: (...args) => backing.getStream(...args),
          delete: () => Promise.reject(new Error("expected delete failure")),
        }
      : backing;
  const fileSystem = createTestFileSystem({
    opaqueStore: store,
    now: () => now,
    uploadSettlementGraceMs: 1,
    onStatement: (_query, rows) => {
      meter.statements += 1;
      meter.rows += rows;
    },
  });
  for (let index = 0; index < count; index += 1) {
    const path = `/opaque-${index}`;
    if (options.expireUploads === true) {
      await fileSystem.beginOpaqueUpload(path, { expiresInMs: 1 });
    } else {
      await putOpaque(fileSystem, store, path, "x");
      await fileSystem.remove(path);
    }
  }
  now = 2;
  meter.reset();
  try {
    await fileSystem.drainGarbage(count);
  } catch (error) {
    if (
      options.failDelete !== true ||
      !(error instanceof Error) ||
      error.message !== "expected delete failure"
    )
      throw error;
  }
  return meter.statements;
}

export async function runChunks(
  fileSystem: NodeSqlFileSystem,
  script: string,
): Promise<{ chunks: number; bytes: number; exitCode: number }> {
  const shell = new Shell({ fileSystem, commands: defaultShellCommands });
  const execution = shell.executeStream({ script });
  const drain = async (
    stream: ReadableStream<Uint8Array>,
  ): Promise<{ chunks: number; bytes: number }> => {
    const reader = stream.getReader();
    let chunks = 0;
    let bytes = 0;
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      chunks += 1;
      bytes += result.value.byteLength;
    }
    return { chunks, bytes };
  };
  const [stdout, , completed] = await Promise.all([
    drain(execution.stdout),
    drain(execution.stderr),
    execution.completed,
  ]);
  return { ...stdout, exitCode: completed.exitCode };
}

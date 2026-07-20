import { performance } from "node:perf_hooks";
import { defaultShellCommands } from "../dist/shell/commands/default.js";
import { Shell } from "../dist/shell/shell.js";
import { MemoryOpaqueStore } from "../dist/testing/opaque-store.js";
import { MemoryFileSystem } from "../dist/vfs/memory.js";
import { putOpaque } from "../dist/vfs/opaque.js";
import { readAllBytes } from "../dist/vfs/streams.js";

const rows = [];
// Marginal Standard-storage operation rates beyond included usage, 2026-07-20.
// https://developers.cloudflare.com/r2/pricing/
const R2_CLASS_A_USD_PER_MILLION = 4.50;
const R2_CLASS_B_USD_PER_MILLION = 0.36;
const REPEATS = 3;

function estimatedR2OperationUsd(classA, classB) {
  return (
    classA * R2_CLASS_A_USD_PER_MILLION
    + classB * R2_CLASS_B_USD_PER_MILLION
  ) / 1_000_000;
}

async function measure(name, details, operation) {
  await operation();
  const durations = [];
  let peakHeapDeltaBytes = 0;
  let peakArrayBufferDeltaBytes = 0;
  let peakExternalDeltaBytes = 0;
  let peakRssDeltaBytes = 0;
  let result;
  let finalMemory;
  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    const before = process.memoryUsage();
    const peaks = { ...before };
    const sample = () => {
      const current = process.memoryUsage();
      for (const key of ["heapUsed", "arrayBuffers", "external", "rss"]) {
        peaks[key] = Math.max(peaks[key], current[key]);
      }
    };
    const sampler = setInterval(sample, 1);
    const started = performance.now();
    try {
      result = await operation();
    } finally {
      durations.push(performance.now() - started);
      sample();
      clearInterval(sampler);
    }
    finalMemory = process.memoryUsage();
    peakHeapDeltaBytes = Math.max(peakHeapDeltaBytes, peaks.heapUsed - before.heapUsed);
    peakArrayBufferDeltaBytes = Math.max(
      peakArrayBufferDeltaBytes,
      peaks.arrayBuffers - before.arrayBuffers,
    );
    peakExternalDeltaBytes = Math.max(peakExternalDeltaBytes, peaks.external - before.external);
    peakRssDeltaBytes = Math.max(peakRssDeltaBytes, peaks.rss - before.rss);
  }
  durations.sort((left, right) => left - right);
  const memory = finalMemory ?? process.memoryUsage();
  rows.push({
    name,
    durationMs: durations[Math.floor(durations.length / 2)],
    repeats: REPEATS,
    heapBytes: memory.heapUsed,
    arrayBufferBytes: memory.arrayBuffers,
    externalBytes: memory.external,
    rssBytes: memory.rss,
    peakHeapDeltaBytes,
    peakArrayBufferDeltaBytes,
    peakExternalDeltaBytes,
    peakRssDeltaBytes,
    backend: "memory",
    sqlRowsRead: null,
    sqlRowsWritten: null,
    databaseBytes: null,
    estimatedSqlRowUsd: null,
    estimatedR2OperationUsd: 0,
    ...details,
    ...result,
  });
}

for (const sizeBytes of [1024, 64 * 1024, 1024 * 1024, 8 * 1024 * 1024]) {
  await measure(`inline-${sizeBytes}`, { sizeBytes }, async () => {
    const fileSystem = new MemoryFileSystem();
    const body = new Uint8Array(sizeBytes);
    body[0] = 1;
    body[body.length - 1] = 2;
    await fileSystem.writeFile("/body", body);
    const read = await readAllBytes(fileSystem.readFile("/body").stream, sizeBytes);
    if (read.byteLength !== sizeBytes || read[0] !== 1 || read.at(-1) !== 2) {
      throw new Error("inline benchmark verification failed");
    }
    return { outputBytes: read.byteLength };
  });
}

await measure("inline-overwrite-1048576", { sizeBytes: 1024 * 1024 }, async () => {
  const fileSystem = new MemoryFileSystem();
  await fileSystem.writeFile("/body", new Uint8Array(1024 * 1024));
  const replacement = new Uint8Array(1024 * 1024);
  replacement[0] = 7;
  await fileSystem.writeFile("/body", replacement);
  const read = await readAllBytes(fileSystem.readFile("/body").stream, replacement.byteLength);
  if (read.byteLength !== replacement.byteLength || read[0] !== 7) {
    throw new Error("inline overwrite benchmark verification failed");
  }
  return { outputBytes: read.byteLength };
});

for (const [name, script] of [
  ["pipeline-1-stage", "wc -c"],
  ["pipeline-3-stage", "cat | cat | wc -c"],
  ["pipeline-6-stage", "cat | cat | cat | cat | cat | wc -c"],
]) {
  await measure(name, { sizeBytes: 1024 * 1024 }, async () => {
    const shell = new Shell({ fileSystem: new MemoryFileSystem(), commands: defaultShellCommands });
    const result = await shell.executeText({ script, stdin: new Uint8Array(1024 * 1024) });
    if (result.exitCode !== 0 || !result.stdout.includes("1048576")) {
      throw new Error(`${name} verification failed`);
    }
    return { outputBytes: Buffer.byteLength(result.stdout) };
  });
}

await measure("tiny-chunk-explosion", { sizeBytes: 16 * 1024, chunks: 16 * 1024 }, async () => {
  const shell = new Shell({ fileSystem: new MemoryFileSystem(), commands: defaultShellCommands });
  const stdin = new ReadableStream({
    start(controller) {
      for (let index = 0; index < 16 * 1024; index += 1) controller.enqueue(Uint8Array.of(0x61));
      controller.close();
    },
  });
  const result = await shell.executeText({ script: "cat | wc -c", stdin });
  if (result.exitCode !== 0 || !result.stdout.includes("16384")) throw new Error("tiny chunks");
  return { outputBytes: Buffer.byteLength(result.stdout) };
});

await measure("buffering-sort-long-line", { sizeBytes: 1024 * 1024 }, async () => {
  const shell = new Shell({
    fileSystem: new MemoryFileSystem(),
    commands: defaultShellCommands,
    limits: { maxLineBytes: 1024 * 1024 + 1 },
  });
  const result = await shell.executeText({ script: "sort | head -c 1", stdin: `${"z".repeat(1024 * 1024)}\n` });
  if (result.exitCode !== 0 || result.stdout !== "z") throw new Error("long line");
  return { outputBytes: Buffer.byteLength(result.stdout) };
});

await measure("early-cancellation", { sizeBytes: 1024 * 1024 }, async () => {
  const shell = new Shell({ fileSystem: new MemoryFileSystem(), commands: defaultShellCommands });
  let pulledBytes = 0;
  const stdin = new ReadableStream({
    pull(controller) {
      if (pulledBytes >= 1024 * 1024) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(4 * 1024);
      pulledBytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const result = await shell.executeText({ script: "set -o pipefail; cat | head -c 1", stdin });
  if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) !== 1) throw new Error("early cancellation");
  if (pulledBytes >= 1024 * 1024) throw new Error("early cancellation consumed the entire source");
  return { outputBytes: 1, pulledBytes };
});

await measure("slow-consumer", {
  sizeBytes: 256 * 1024,
  inputChunks: 64,
  consumerDelayMs: 1,
}, async () => {
  const shell = new Shell({ fileSystem: new MemoryFileSystem(), commands: defaultShellCommands });
  const stdin = new ReadableStream({
    start(controller) {
      for (let index = 0; index < 64; index += 1) {
        controller.enqueue(new Uint8Array(4 * 1024));
      }
      controller.close();
    },
  });
  const execution = shell.executeStream({ script: "cat", stdin });
  const consumeSlowly = async () => {
    const reader = execution.stdout.getReader();
    let outputBytes = 0;
    let outputChunks = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      outputBytes += value.byteLength;
      outputChunks += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return { outputBytes, outputChunks };
  };
  const [status, output, error] = await Promise.all([
    execution.completed,
    consumeSlowly(),
    new Response(execution.stderr).arrayBuffer(),
  ]);
  if (status.exitCode !== 0 || output.outputBytes !== 256 * 1024 || error.byteLength !== 0) {
    throw new Error("slow consumer verification failed");
  }
  return output;
});

await measure("concurrent-shells", { concurrency: 4, sizeBytes: 256 * 1024 }, async () => {
  const fileSystem = new MemoryFileSystem();
  const shell = new Shell({ fileSystem, commands: defaultShellCommands });
  const executions = Array.from({ length: 4 }, () => {
    return shell.executeText({ script: "cat | wc -c", stdin: new Uint8Array(256 * 1024) });
  });
  const results = await Promise.all(executions);
  if (results.some((result) => result.exitCode !== 0 || !result.stdout.includes("262144"))) {
    throw new Error("concurrent shells");
  }
  return { outputBytes: results.reduce((total, result) => total + Buffer.byteLength(result.stdout), 0) };
});

await measure("opaque-lifecycle-gc", { sizeBytes: 1024 * 1024 }, async () => {
  const store = new MemoryOpaqueStore();
  const fileSystem = new MemoryFileSystem({ opaqueStore: store });
  await putOpaque(fileSystem, store, "/opaque", new Uint8Array(1024 * 1024));
  fileSystem.remove("/opaque");
  await fileSystem.drainGarbage(100);
  return {
    ...store.operations,
    r2ClassAOperations: store.operations.puts,
    r2ClassBOperations: store.operations.heads + store.operations.gets,
    r2FreeDeleteOperations: store.operations.deleteRequests,
    estimatedR2OperationUsd: estimatedR2OperationUsd(
      store.operations.puts,
      store.operations.heads + store.operations.gets,
    ),
    outputBytes: 0,
  };
});

await measure("opaque-gc-batch", { objects: 64, sizeBytes: 64 * 1024 }, async () => {
  const store = new MemoryOpaqueStore();
  const fileSystem = new MemoryFileSystem({ opaqueStore: store });
  for (let index = 0; index < 64; index += 1) {
    await putOpaque(fileSystem, store, `/opaque-${index}`, new Uint8Array(64 * 1024));
    fileSystem.remove(`/opaque-${index}`);
  }
  const result = await fileSystem.drainGarbage(100);
  if (result.deleted !== 64 || result.remaining !== 0) throw new Error("opaque GC batch");
  return {
    ...store.operations,
    r2ClassAOperations: store.operations.puts,
    r2ClassBOperations: store.operations.heads + store.operations.gets,
    r2FreeDeleteOperations: store.operations.deleteRequests,
    estimatedR2OperationUsd: estimatedR2OperationUsd(
      store.operations.puts,
      store.operations.heads + store.operations.gets,
    ),
    outputBytes: 0,
  };
});

if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(rows)}\n`);
else console.table(rows);

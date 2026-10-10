import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { createFsAdapter } from "../dist/fs/index.js";
import { NodeSqlFileSystem } from "../dist/testing/node.js";
import { sha256Hex } from "../dist/vfs/digest.js";

const results = [];
const summaries = [];
const trials = 7;
const warmups = 3;
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const meter = { statements: 0, returnedRows: 0 };
const vfs = new NodeSqlFileSystem({
  onStatement: (_query, rows) => {
    meter.statements++;
    meter.returnedRows += rows;
  },
});

async function collect(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  return { chunks, size };
}

async function compare(name, size, repetitions, operations) {
  const samples = operations.map(() => []);
  for (let trial = -warmups; trial < trials; trial++) {
    const order = trial % 2 === 0 ? [0, 1] : [1, 0];
    for (const index of order) {
      const [variant, operation] = operations[index];
      meter.statements = 0;
      meter.returnedRows = 0;
      const start = performance.now();
      for (let i = 0; i < repetitions; i++) await operation();
      const ms = performance.now() - start;
      if (trial >= 0) {
        samples[index].push(ms);
        results.push({ name, size, repetitions, variant, trial, ms, ...meter });
      }
    }
  }
  const summary = operations.map(([variant], index) => {
    const measured = results.filter(
      (r) => r.name === name && r.size === size && r.variant === variant,
    );
    return {
      variant,
      medianMs: median(samples[index]),
      statementsPerOperation: median(measured.map((r) => r.statements)) / repetitions,
      returnedRowsPerOperation: median(measured.map((r) => r.returnedRows)) / repetitions,
    };
  });
  const result = { name, size, repetitions, summary };
  summaries.push(result);
  console.log(JSON.stringify(result));
}

async function traversal(path, pageSize) {
  const entries = [];
  let cursor;
  do {
    const page = vfs.findPage({ path, includeRoot: true, limit: pageSize, cursor });
    entries.push(...page.entries);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return entries;
}

try {
  for (const size of [100, 10_000, 20_000]) {
    const path = `/tree${size}`;
    vfs.mkdir(path);
    await vfs.writeFiles(
      Array.from({ length: size }, (_, i) => ({ path: `${path}/f${i}`, body: "abcd" })),
    );
    const expected = { entries: size + 1, inlineBytes: size * 4, logicalFileBytes: size * 4 };
    await compare("subtree-summary", size, 10, [
      ["aggregate", () => assert.deepEqual(vfs.subtreeSummary(path), expected)],
      [
        "paged-walk",
        async () => {
          const entries = await traversal(path, 1000);
          assert.equal(entries.length, expected.entries);
          assert.equal(
            entries.reduce((sum, stat) => sum + stat.sizeBytes, 0),
            expected.logicalFileBytes,
          );
        },
      ],
    ]);
    await compare("list-page-first", size, 30, [
      ["listPage", () => assert.equal(vfs.listPage(path, { limit: 100 }).entries.length, 100)],
      ["list-slice", () => assert.equal(vfs.list(path).slice(0, 100).length, 100)],
    ]);
    await compare("find-page-first", size, 30, [
      ["findPage", () => assert.equal(vfs.findPage({ path, limit: 100 }).entries.length, 100)],
      ["find-limit", () => assert.equal(vfs.find({ path, limit: 100 }).length, 100)],
    ]);
  }
  for (const size of [8192, 8 * 1024 * 1024]) {
    await vfs.writeFile("/body", new Uint8Array(size).fill(65));
    const expectedDigest = await vfs.digestFile("/body");
    await compare("digest-warm", size, 20, [
      ["cached", async () => assert.equal(await vfs.digestFile("/body"), expectedDigest)],
      [
        "read-hash",
        async () => {
          const { chunks, size: length } = await collect(vfs.readFile("/body").stream);
          assert.equal(await sha256Hex(chunks, length), expectedDigest);
        },
      ],
    ]);
    await compare("range", size, 30, [
      [
        "ranged",
        async () =>
          assert.equal(
            (await collect(vfs.readFile("/body", { range: { suffix: 16 } }).stream)).size,
            16,
          ),
      ],
      [
        "whole-read",
        async () => assert.equal((await collect(vfs.readFile("/body").stream)).size, size),
      ],
    ]);
    const fs = createFsAdapter(vfs).promises;
    await compare("range-vs-descriptor", size, 30, [
      [
        "ranged",
        async () =>
          assert.equal(
            (await collect(vfs.readFile("/body", { range: { suffix: 16 } }).stream)).size,
            16,
          ),
      ],
      [
        "open-read-close",
        async () => {
          const handle = await fs.open("/body", "r");
          try {
            const result = await handle.read(new Uint8Array(16), 0, 16, size - 16);
            assert.equal(result.bytesRead, 16);
          } finally {
            await handle.close();
          }
        },
      ],
    ]);
    const body = "A".repeat(size);
    await vfs.writeFile("/unchanged", body, { skipIfUnchanged: true });
    await compare("unchanged-write", size, size === 8192 ? 30 : 3, [
      ["skip", () => vfs.writeFile("/unchanged", body, { skipIfUnchanged: true })],
      ["overwrite", () => vfs.writeFile("/unchanged", body)],
    ]);
  }
  for (const size of [1, 3, 100]) {
    const entries = Array.from({ length: size }, (_, i) => ({
      path: `/batch${size}-${i}`,
      body: "body",
    }));
    await vfs.writeFiles(entries);
    await compare("batch-overwrite", size, 20, [
      ["batch", () => vfs.writeFiles(entries)],
      [
        "individual",
        async () => {
          for (const entry of entries) await vfs.writeFile(entry.path, entry.body);
        },
      ],
    ]);
  }
  // A bounded find result has no continuation indicator. A filtered page can
  // be empty while still supplying the cursor needed to reach later matches.
  assert.equal(vfs.find({ path: "/tree20000", includeRoot: true }).length, 10_000);
  const empty = vfs.findPage({ path: "/tree20000", name: "no-match", limit: 100 });
  assert.equal(empty.entries.length, 0);
  assert.notEqual(empty.nextCursor, null);
} finally {
  vfs.close();
}
writeFileSync(
  new URL("./extension-api-results.json", import.meta.url),
  `${JSON.stringify({ node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, trials, warmups, summaries, results }, null, 2)}\n`,
);

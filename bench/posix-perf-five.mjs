/** Five independent POSIX-preserving optimization probes; setup/verification excluded. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { distribution, pairedRatio } from "./comparison.mjs";

const cases = [
  { name: "fstat", size: 80, count: 1500 },
  { name: "fd-read", size: 8192, count: 200 },
  { name: "fd-read-detached", size: 8192, count: 200 },
  { name: "create-wide", size: 0, count: 300 },
  { name: "create-wide", size: 1000, count: 300 },
  { name: "rename-wide", size: 1000, count: 500 },
  { name: "truncate-zero", size: 1048576, count: 40 },
  { name: "truncate-boundary", size: 1048576, count: 40 },
  { name: "truncate-zero", size: 8388608, count: 12 },
  { name: "write-full", size: 8192, count: 500 },
  { name: "write-full", size: 1048576, count: 40 },
  { name: "write-unaligned", size: 1048576, count: 40 },
  { name: "write-byte", size: 1048576, count: 1000 },
  { name: "alias-chmod", size: 0, count: 1000 },
  { name: "alias-chmod", size: 1, count: 1000 },
  { name: "alias-write", size: 1, count: 300 },
];
const selected = process.env.PERF_CASES?.split(",");
const workloads = cases.filter((item) => !selected || selected.includes(item.name));
if (process.env.PERF_BEFORE) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cf-vfs-five-pair-"));
  const raw = [];
  try {
    for (let trial = 0; trial < Number(process.env.PERF_TRIALS || 7); trial++) {
      const order = trial % 2 ? ["after", "before"] : ["before", "after"];
      for (const variant of order) {
        const output = path.join(temp, "sample.json");
        execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
          env: {
            ...process.env,
            PERF_BEFORE: "",
            PERF_LIBRARY:
              variant === "before" ? process.env.PERF_BEFORE : process.env.PERF_LIBRARY || "dist",
            PERF_OUTPUT: output,
          },
          stdio: "pipe",
        });
        raw.push(
          ...JSON.parse(await fs.readFile(output, "utf8")).results.map((row) => ({
            ...row,
            variant,
            trial,
          })),
        );
      }
    }
    const results = workloads.map((item) => {
      const samples = (variant) =>
        raw.filter(
          (row) => row.variant === variant && row.name === item.name && row.size === item.size,
        );
      const before = samples("before"),
        after = samples("after");
      return {
        ...item,
        before: {
          ms: distribution(before.map((row) => row.ms)),
          sql: before[0].sql,
          returnedRows: before[0].returnedRows,
          blobBytes: before[0].blobBytes,
        },
        after: {
          ms: distribution(after.map((row) => row.ms)),
          sql: after[0].sql,
          returnedRows: after[0].returnedRows,
          blobBytes: after[0].blobBytes,
        },
        ratio: pairedRatio(
          before.map((row) => row.ms),
          after.map((row) => row.ms),
        ),
      };
    });
    await fs.writeFile(
      process.env.PERF_OUTPUT,
      `${JSON.stringify({ method: "isolated processes, warmup per workload, alternating AB/BA", node: process.version, platform: process.platform, results, raw }, null, 2)}\n`,
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
  process.exit(0);
}
const root = path.resolve(process.env.PERF_LIBRARY || "dist");
const { NodeSqlFileSystem } = await import(pathToFileURL(path.join(root, "testing/node.js")));
const { createFsAdapter } = await import(pathToFileURL(path.join(root, "fs/index.js")));
async function prepare(item) {
  let sql = 0,
    returnedRows = 0,
    blobBytes = 0;
  const v = new NodeSqlFileSystem({
    chunkBytes: 32768,
    onStatement: (_query, rows) => {
      sql++;
      returnedRows += rows;
    },
  });
  const original = v.storage.sql.exec.bind(v.storage.sql);
  v.storage.sql.exec = (...args) => {
    const cursor = original(...args);
    const observe = (row) => {
      for (const value of Object.values(row))
        if (value instanceof ArrayBuffer) blobBytes += value.byteLength;
      return row;
    };
    return { one: () => observe(cursor.one()), toArray: () => cursor.toArray().map(observe) };
  };
  const f = createFsAdapter(v).promises;
  const handles = [];
  const body = new Uint8Array(item.size || 80).fill(65);
  if (item.name.endsWith("wide")) {
    await f.mkdir("/dir");
    for (let i = 0; i < item.size; i++) await f.mkdir(`/dir/d${i}`);
    if (item.name === "rename-wide") await f.writeFile("/dir/a", "x");
  } else if (item.name.startsWith("truncate") || item.name.startsWith("fd-read")) {
    for (let i = 0; i < item.count; i++) {
      await f.writeFile(`/f${i}`, body);
      const handle = await f.open(`/f${i}`, "r+");
      await handle.stat();
      handles.push(handle);
      if (item.name === "fd-read-detached") await f.unlink(`/f${i}`);
    }
  } else {
    await f.writeFile("/a", body);
    if (item.name.startsWith("alias") && item.size) {
      await f.writeFile("/linked", "x");
      await f.link("/linked", "/alias");
    }
    if (item.name === "fstat" || item.name.startsWith("write")) {
      handles.push(await f.open("/a", "r+"));
      await handles[0].stat();
    }
  }
  sql = returnedRows = blobBytes = 0;
  let seen = 0;
  const bytes = item.name === "write-byte" ? new Uint8Array([66]) : body;
  return {
    async run() {
      for (let i = 0; i < item.count; i++) {
        if (item.name === "fstat") seen += (await handles[0].stat()).size;
        else if (item.name.startsWith("fd-read")) seen += (await handles[i].readFile()).byteLength;
        else if (item.name === "create-wide") await f.writeFile(`/dir/f${i}`, "x");
        else if (item.name === "rename-wide")
          await f.rename(i % 2 ? "/dir/b" : "/dir/a", i % 2 ? "/dir/a" : "/dir/b");
        else if (item.name.startsWith("truncate"))
          await handles[i].truncate(item.name === "truncate-zero" ? 0 : 32769);
        else if (item.name.startsWith("write"))
          await handles[0].write(bytes, 0, bytes.length, item.name === "write-unaligned" ? 1 : 0);
        else if (item.name === "alias-chmod") await f.chmod("/a", i % 2 ? 0o600 : 0o644);
        else if (item.name === "alias-write") await f.writeFile("/a", i % 2 ? "x" : "y");
      }
      return { sql, returnedRows, blobBytes };
    },
    async verify() {
      if (item.name === "fstat" || item.name.startsWith("fd-read"))
        assert.equal(seen, item.count * body.byteLength);
      else if (item.name === "create-wide")
        assert.equal((await f.readdir("/dir")).length, item.size + item.count);
      else if (item.name.startsWith("truncate"))
        for (const handle of handles)
          assert.equal((await handle.stat()).size, item.name === "truncate-zero" ? 0 : 32769);
      else if (item.name.startsWith("write")) {
        const output = await f.readFile("/a");
        if (item.name === "write-byte") {
          assert.equal(output[0], 66);
          assert.equal(output[1], 65);
        } else {
          assert.equal(output.length, item.size + (item.name === "write-unaligned" ? 1 : 0));
          assert.ok(output.every((value) => value === 65));
        }
      }
    },
    async close() {
      for (const handle of handles) await handle.close();
      v.close();
    },
  };
}
const results = [];
for (const item of workloads) {
  for (let warmup = 1; warmup >= 0; warmup--) {
    const suite = await prepare(item);
    try {
      const start = performance.now();
      const counters = await suite.run();
      const ms = performance.now() - start;
      await suite.verify();
      if (!warmup) results.push({ ...item, ms, ...counters });
    } finally {
      await suite.close();
    }
  }
}
await fs.writeFile(
  process.env.PERF_OUTPUT || "/tmp/cf-vfs-five.json",
  `${JSON.stringify({ results }, null, 2)}\n`,
);

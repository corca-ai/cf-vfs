/** Portable real-FS/VFS profiles. Setup and verification are outside timing. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const library = path.resolve(process.env.POSIX_LIBRARY || "dist");
// Separate processes avoid module-identity and allocator bias in A/B reads.
if (process.env.POSIX_COMPARE_LIBRARY) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cf-vfs-posix-pair-"));
  const candidates = [
    { label: "before", root: path.resolve(process.env.POSIX_COMPARE_LIBRARY) },
    { label: "after", root: library },
  ];
  const results = [];
  try {
    for (let trial = 0; trial < Number(process.env.POSIX_TRIALS || 5); trial++) {
      for (const candidate of trial % 2 ? candidates.toReversed() : candidates) {
        const output = path.join(directory, `${trial}-${candidate.label}.json`);
        execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
          env: {
            ...process.env,
            POSIX_COMPARE_LIBRARY: "",
            POSIX_LIBRARY: candidate.root,
            POSIX_TRIALS: "1",
            POSIX_OUTPUT: output,
          },
          stdio: "pipe",
        });
        const rows = JSON.parse(await fs.readFile(output, "utf8")).results;
        results.push(...rows.map((row) => ({ ...row, trial, variant: candidate.label })));
      }
    }
    await fs.writeFile(
      process.env.POSIX_OUTPUT || "/tmp/cf-vfs-posix-profile.json",
      `${JSON.stringify(
        {
          method: "alternating isolated processes",
          node: process.version,
          platform: process.platform,
          results,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
  process.exit(0);
}
async function loadLibrary(root) {
  const modules = await Promise.all([
    import(pathToFileURL(path.join(root, "testing/node.js"))),
    import(pathToFileURL(path.join(root, "fs/index.js"))),
    import(pathToFileURL(path.join(root, "fs/metadata.js"))),
    import(pathToFileURL(path.join(root, "testing/opaque-store.js"))),
    import(pathToFileURL(path.join(root, "vfs/streams.js"))),
  ]);
  return Object.assign({}, ...modules);
}
const variant = process.env.POSIX_VARIANT || "baseline";
const trials = Number(process.env.POSIX_TRIALS || 5);
const candidates = [{ label: variant, root: library }];
for (const candidate of candidates) candidate.modules = await loadLibrary(candidate.root);
const cases = [
  ...[1, 16, 64].map((size) => ({ op: "stat-depth", size, repeat: 500 })),
  ...[0, 80, 8192, 32768].map((size) => ({ op: "read-small", size, repeat: 300 })),
  ...[100, 1000].map((size) => ({ op: "list-stat", size, repeat: 1 })),
  ...[0, 80, 8192].map((size) => ({ op: "create", size, repeat: 300 })),
  ...[0, 80, 8192].map((size) => ({ op: "overwrite", size, repeat: 300 })),
  ...[80, 1024 * 1024, 8 * 1024 * 1024].map((size) => ({ op: "rename", size, repeat: 100 })),
  ...[80, 1024 * 1024, 8 * 1024 * 1024].map((size) => ({ op: "rename-replace", size, repeat: 1 })),
  ...[8192, 16384, 32768, 1024 * 1024, 8 * 1024 * 1024].map((size) => ({
    op: "range",
    size,
    repeat: 200,
  })),
  ...[80, 256 * 1024, 1024 * 1024].map((size) => ({ op: "append", size, repeat: 100 })),
];
const selected = process.env.POSIX_CASES?.split(",");
const selectedSizes = process.env.POSIX_SIZES?.split(",").map(Number);
const results = [];

async function prepare(kind, item, modules) {
  const { NodeSqlFileSystem, createFsAdapter, FsMetadataCache, MemoryOpaqueStore, collectBytes } =
    modules;
  let sql = 0,
    returnedRows = 0,
    blobBytes = 0;
  const cache = ["cache", "3"].includes(variant) ? new FsMetadataCache() : undefined;
  const store = new MemoryOpaqueStore();
  const vfs =
    kind === "vfs"
      ? new NodeSqlFileSystem({
          opaqueStore: store,
          onEvent: variant === "3" ? undefined : cache?.onEvent,
          onStatement: (_query, n) => {
            sql++;
            returnedRows += n;
          },
        })
      : undefined;
  const root = vfs ? "/profile" : await fs.mkdtemp(path.join(os.tmpdir(), "cf-vfs-posix-profile-"));
  const promises = vfs ? createFsAdapter(vfs, { metadataCache: cache }).promises : fs;
  if (vfs) {
    const port = vfs.storage.sql;
    const exec = port.exec.bind(port);
    port.exec = (...args) => {
      const cursor = exec(...args);
      const count = (row) => {
        for (const value of Object.values(row))
          if (value instanceof ArrayBuffer) blobBytes += value.byteLength;
        return row;
      };
      return { one: () => count(cursor.one()), toArray: () => cursor.toArray().map(count) };
    };
  }
  await promises.mkdir(root, { recursive: true });
  let file = `${root}/file`;
  if (item.op === "stat-depth") {
    const directory = `${root}/${Array(item.size).fill("d").join("/")}`;
    await promises.mkdir(directory, { recursive: true });
    file = `${directory}/file`;
  }
  const body = new Uint8Array(
    item.op === "stat-depth" || item.op === "list-stat" ? 80 : item.size,
  ).fill(7);
  if (item.op === "list-stat") {
    for (let i = 0; i < item.size; i++) await promises.writeFile(`${root}/f${i}`, body);
  } else if (item.op !== "create") await promises.writeFile(file, body);
  if (item.op === "rename-replace") await promises.writeFile(`${root}/moved`, body);
  let access = vfs;
  if (vfs && item.op === "stat-depth") access = vfs.forCredentials({ uid: 1001, gid: 1001 });
  sql = 0;
  returnedRows = 0;
  blobBytes = 0;
  return {
    async run() {
      for (let i = 0; i < item.repeat; i++) {
        if (item.op === "stat-depth") {
          if (access) access.stat(file);
          else await fs.stat(file);
        } else if (item.op === "read-small") {
          const read = await promises.readFile(file);
          assert.equal(read.byteLength, body.byteLength);
        } else if (item.op === "list-stat") {
          for (const name of await promises.readdir(root)) await promises.lstat(`${root}/${name}`);
        } else if (item.op === "create") await promises.writeFile(`${root}/f${i}`, body);
        else if (item.op === "overwrite") await promises.writeFile(file, body);
        else if (item.op === "rename-replace") await promises.rename(file, `${root}/moved`);
        else if (item.op === "rename") {
          await promises.rename(i % 2 ? `${root}/moved` : file, i % 2 ? file : `${root}/moved`);
        } else if (item.op === "range") {
          const offset = Math.floor(body.byteLength / 2);
          if (vfs) {
            const read = await collectBytes(
              vfs.readFile(file, { range: { offset, length: 16 } }).stream,
              16,
            );
            assert.equal(read.sizeBytes, 16);
          } else {
            const handle = await fs.open(file, "r");
            try {
              assert.equal((await handle.read(new Uint8Array(16), 0, 16, offset)).bytesRead, 16);
            } finally {
              await handle.close();
            }
          }
        } else if (item.op === "append") await promises.writeFile(file, "x", { flag: "a" });
      }
      return { sql, returnedRows, blobBytes };
    },
    async verify() {
      if (item.op === "create" || item.op === "list-stat")
        assert.equal(
          (await promises.readdir(root)).length,
          item.op === "create" ? item.repeat : item.size,
        );
      else
        assert.equal(
          (await promises.stat(item.op === "rename-replace" ? `${root}/moved` : file)).size,
          body.byteLength + (item.op === "append" ? item.repeat : 0),
        );
    },
    async close() {
      if (vfs) vfs.close();
      else await fs.rm(root, { recursive: true, force: true });
    },
  };
}

for (const original of cases.filter(
  (item) =>
    (!selected || selected.includes(item.op)) &&
    (!selectedSizes || selectedSizes.includes(item.size)),
)) {
  const item = {
    ...original,
    repeat:
      original.op === "list-stat"
        ? Number(process.env.POSIX_LIST_REPEATS || 1)
        : original.repeat === 1
          ? 1
          : original.repeat * Number(process.env.POSIX_REPEAT_FACTOR || 1),
  };
  for (let trial = -1; trial < trials; trial++) {
    for (const candidate of trial % 2 ? candidates.toReversed() : candidates) {
      for (const kind of trial % 2 ? ["vfs", "native"] : ["native", "vfs"]) {
        const suite = await prepare(kind, item, candidate.modules);
        try {
          const started = performance.now();
          const counters = await suite.run();
          const ms = performance.now() - started;
          await suite.verify();
          if (trial >= 0)
            results.push({ variant: candidate.label, ...item, kind, trial, ms, ...counters });
        } finally {
          await suite.close();
        }
      }
    }
  }
}
await fs.writeFile(
  process.env.POSIX_OUTPUT || "/tmp/cf-vfs-posix-profile.json",
  `${JSON.stringify({ variant, node: process.version, platform: process.platform, results }, null, 2)}\n`,
);

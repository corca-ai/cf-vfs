/** Real Git probe. Build first; the pinned dev dependency supplies isomorphic-git.
 * GIT_PROBE_VARIANT=fs node bench/git-workload.mjs
 * Local HTTP remote only. No library changes or production credentials.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createLineDiff } from "../dist/core/line-diff.js";

const library = process.env.GIT_PROBE_LIBRARY
  ? pathToFileURL(`${path.resolve(process.env.GIT_PROBE_LIBRARY)}/`)
  : new URL("../dist/", import.meta.url);
const { NodeSqlFileSystem } = await import(new URL("testing/node.js", library));

const require = createRequire(
  path.join(
    process.env.GIT_PROBE_DEPS || path.resolve(new URL("..", import.meta.url).pathname),
    "package.json",
  ),
);
const variant = process.env.GIT_PROBE_VARIANT || "baseline";
const timingOnly = process.env.GIT_PROBE_TIMING_ONLY === "1";
const { FsMetadataCache } =
  variant === "metadata" || variant === "combined"
    ? await import(new URL("fs/metadata.js", library))
    : {};
const { createFsAdapter } =
  variant === "fs" || variant === "tiered" || variant === "combined"
    ? await import(new URL("fs/index.js", library))
    : {};
const { TieredFileContent } =
  variant === "tiered" || variant === "combined"
    ? await import(new URL("fs/content.js", library))
    : {};
const { MemoryOpaqueStore } = await import(new URL("testing/opaque-store.js", library));
const git = require("isomorphic-git");
const http = require("isomorphic-git/http/node");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-vfs-git-"));
const nativeVolume = execFileSync("df", ["-P", root], { encoding: "utf8" }).trim();
const results = [];
const author = {
  name: "VFS probe",
  email: "probe@example.invalid",
  timestamp: 1700000000,
  timezoneOffset: 0,
};
function stats(s) {
  return {
    size: s.sizeBytes,
    mode: s.mode,
    ino: s.ino,
    uid: s.uid,
    gid: s.gid,
    dev: 1,
    mtimeMs: s.modifiedAtMs,
    ctimeMs: s.modifiedAtMs,
    mtime: new Date(s.modifiedAtMs),
    ctime: new Date(s.modifiedAtMs),
    isFile: () => s.kind === "file",
    isDirectory: () => s.kind === "directory",
    isSymbolicLink: () => s.kind === "symlink",
  };
}
function adapter(vfs, metadata) {
  return {
    promises: {
      async readFile(p, options) {
        const { stream } = vfs.readFile(p);
        const b = Buffer.from(await new Response(stream).arrayBuffer());
        const enc = typeof options === "string" ? options : options?.encoding;
        return enc ? b.toString(enc) : b;
      },
      async writeFile(p, b) {
        await vfs.writeFile(p, b);
      },
      async stat(p) {
        return stats(metadata ? metadata.stat(vfs, p, true) : vfs.stat(p));
      },
      async lstat(p) {
        return stats(metadata ? metadata.stat(vfs, p, false) : vfs.lstat(p));
      },
      async readdir(p) {
        return (metadata ? metadata.list(vfs, p) : vfs.list(p)).map((s) => s.name);
      },
      async mkdir(p) {
        try {
          vfs.lstat(p);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
          return vfs.mkdir(p);
        }
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      },
      async unlink(p) {
        await vfs.remove(p);
      },
      async rmdir(p) {
        await vfs.remove(p);
      },
      async rm(p, o) {
        try {
          await vfs.remove(p, { recursive: o?.recursive });
        } catch (e) {
          if (!o?.force || e.code !== "ENOENT") throw e;
        }
      },
      async readlink(p) {
        return vfs.readlink(p);
      },
      async symlink(t, p) {
        return vfs.symlink(p, t);
      },
      async chmod(p, mode) {
        return vfs.setMetadata(p, { mode });
      },
    },
  };
}
function instrument(base) {
  let meter;
  function reset() {
    meter = {
      calls: {},
      readBytes: 0,
      writeBytes: 0,
      indexReadBytes: 0,
      indexWriteBytes: 0,
      fsCallMs: 0,
      sql: 0,
      returnedRows: 0,
      queries: {},
      failures: [],
    };
  }
  reset();
  if (timingOnly) return { fs: base, reset, get: () => structuredClone(meter) };
  const promises = Object.fromEntries(
    Object.entries(base.promises).map(([name, fn]) => [
      name,
      async (...args) => {
        meter.calls[name] = (meter.calls[name] || 0) + 1;
        const start = performance.now();
        if (name === "writeFile") {
          const n = Buffer.byteLength(args[1]);
          meter.writeBytes += n;
          if (args[0].endsWith("/index")) meter.indexWriteBytes += n;
        }
        try {
          const value = await fn(...args);
          if (name === "readFile") {
            const n = Buffer.byteLength(value);
            meter.readBytes += n;
            if (args[0].endsWith("/index")) meter.indexReadBytes += n;
          }
          return value;
        } catch (e) {
          if (name === "writeFile")
            meter.failures.push({
              operation: name,
              path: args[0],
              code: e.code || e.name,
              bytes: name === "writeFile" ? Buffer.byteLength(args[1]) : undefined,
            });
          throw e;
        } finally {
          meter.fsCallMs += performance.now() - start;
        }
      },
    ]),
  );
  return {
    fs: { promises },
    reset,
    get: () => structuredClone(meter),
    observe(q, rows) {
      meter.sql++;
      meter.returnedRows += rows;
      const key = q.replace(/\s+/g, " ").trim();
      meter.queries[key] = (meter.queries[key] || 0) + 1;
    },
  };
}
async function remote() {
  const remoteDir = path.join(root, "remote.git");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remoteDir]);
  execFileSync("git", ["--git-dir", remoteDir, "config", "http.receivepack", "true"]);
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://localhost");
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const child = spawn("git", ["http-backend"], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: u.pathname,
          QUERY_STRING: u.search.slice(1),
          REQUEST_METHOD: req.method,
          CONTENT_TYPE: req.headers["content-type"] || "",
          CONTENT_LENGTH: String(body.length),
          REMOTE_USER: "probe",
        },
      });
      const out = [];
      child.stdout.on("data", (c) => out.push(c));
      child.stderr.resume();
      child.stdin.end(body);
      await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`http-backend ${code}`)),
        );
      });
      const response = Buffer.concat(out);
      const end = response.indexOf("\r\n\r\n");
      assert(end >= 0);
      for (const line of response.subarray(0, end).toString().split("\r\n")) {
        const i = line.indexOf(":");
        const key = line.slice(0, i);
        const val = line.slice(i + 1).trim();
        if (key.toLowerCase() === "status") res.statusCode = Number(val.split(" ")[0]);
        else res.setHeader(key, val);
      }
      res.end(response.subarray(end + 4));
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/remote.git`, remoteDir };
}
const r = await remote();
async function run(kind, count, trial) {
  let vfs;
  let meter;
  const metadata = FsMetadataCache
    ? new FsMetadataCache(Number(process.env.GIT_PROBE_METADATA_ENTRIES || 4096))
    : undefined;
  const store = TieredFileContent ? new MemoryOpaqueStore() : undefined;
  if (kind === "vfs")
    vfs = new NodeSqlFileSystem({
      ...(timingOnly ? {} : { onStatement: (q, n) => meter?.observe(q, n) }),
      ...(metadata ? { onEvent: metadata.onEvent } : {}),
      ...(store ? { opaqueStore: store } : {}),
    });
  const dir = kind === "vfs" ? "/repo" : path.join(root, `${kind}-${count}-${trial}`);
  const base = vfs
    ? createFsAdapter
      ? createFsAdapter(vfs, {
          ...(metadata ? { metadataCache: metadata } : {}),
          ...(store
            ? { content: new TieredFileContent(vfs, store), maxReadFileBytes: 32 * 1024 * 1024 }
            : {}),
        })
      : adapter(vfs, metadata)
    : {
        promises: Object.fromEntries(
          [
            "readFile",
            "writeFile",
            "stat",
            "lstat",
            "readdir",
            "mkdir",
            "unlink",
            "rmdir",
            "rm",
            "readlink",
            "symlink",
            "chmod",
          ].map((n) => [n, fs.promises[n].bind(fs.promises)]),
        ),
      };
  // Reuse one meter for filesystem calls and SQL observation.
  meter = instrument(base);
  const client = meter.fs;
  const opts = { fs: client, dir };
  const remoteDir = path.join(root, `remote-${kind}-${count}-${trial}.git`);
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remoteDir]);
  execFileSync("git", ["--git-dir", remoteDir, "config", "http.receivepack", "true"]);
  const url = r.url.replace("/remote.git", `/remote-${kind}-${count}-${trial}.git`);
  async function step(name, fn) {
    meter.reset();
    const start = performance.now();
    let error = null;
    let value;
    try {
      value = await fn();
    } catch (e) {
      error = { code: e.code || e.name, message: e.message };
    }
    const elapsedMs = performance.now() - start;
    const m = meter.get();
    const topQueries = Object.entries(m.queries)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    m.queries = undefined;
    const row = {
      kind,
      count,
      trial,
      name,
      ms: elapsedMs,
      ...m,
      topQueries,
      error,
    };
    results.push(row);
    console.log(JSON.stringify(row));
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    return value;
  }
  try {
    await client.promises.mkdir(dir);
    await git.init({ ...opts, defaultBranch: "main" });
    await step("populate", async () => {
      for (let i = 0; i < count; i++) {
        const sub = `d${Math.floor(i / 100)}`;
        if (i % 100 === 0) await client.promises.mkdir(`${dir}/${sub}`);
        await client.promises.writeFile(
          `${dir}/${sub}/f${i}.txt`,
          `file ${i}\n${"const x = 1;\n".repeat(60)}`,
        );
      }
    });
    await step("add-all", () => git.add({ ...opts, filepath: "." }));
    const first = await step("commit-initial", () =>
      git.commit({ ...opts, message: "initial", author }),
    );
    for (let i = 0; i < 3; i++)
      await step(`status-clean-${i}`, async () => {
        const m = await git.statusMatrix(opts);
        assert.equal(m.length, count);
        assert(m.every((x) => x[1] === 1 && x[2] === 1 && x[3] === 1));
      });
    await client.promises.writeFile(
      `${dir}/d0/f0.txt`,
      `file 0 changed\n${"const x = 2;\n".repeat(60)}`,
    );
    await step("status-one-change", async () => {
      const m = await git.statusMatrix(opts);
      assert.equal(m.filter((x) => x[1] !== x[2]).length, 1);
    });
    await step("diff-one-change", async () => {
      const m = await git.statusMatrix(opts);
      let changed = 0;
      for (const [filepath, h, w] of m) {
        if (h === w) continue;
        const old = await git.readBlob({ ...opts, oid: first, filepath });
        const next = await client.promises.readFile(`${dir}/${filepath}`);
        assert(
          createLineDiff(Buffer.from(old.blob).toString(), Buffer.from(next).toString()).changes >
            0,
        );
        changed++;
      }
      assert.equal(changed, 1);
    });
    await step("add-one", () => git.add({ ...opts, filepath: "d0/f0.txt" }));
    const second = await step("commit-one", () =>
      git.commit({ ...opts, message: "one change", author }),
    );
    await step("branch-create", () => git.branch({ ...opts, ref: "feature" }));
    await step("checkout-old", () => git.checkout({ ...opts, ref: first }));
    assert.match(await client.promises.readFile(`${dir}/d0/f0.txt`, "utf8"), /x = 1/);
    await step("checkout-main", () => git.checkout({ ...opts, ref: "main" }));
    assert.match(await client.promises.readFile(`${dir}/d0/f0.txt`, "utf8"), /x = 2/);
    await step("push", async () => {
      const pushed = await git.push({
        ...opts,
        http,
        url,
        ref: "main",
        remoteRef: `${kind}-${count}-${trial}`,
      });
      assert.equal(pushed.ok, true);
      assert.equal(
        execFileSync(
          "git",
          ["--git-dir", remoteDir, "rev-parse", `refs/heads/${kind}-${count}-${trial}`],
          { encoding: "utf8" },
        ).trim(),
        second,
      );
    });
    execFileSync("git", [
      "--git-dir",
      remoteDir,
      "symbolic-ref",
      "HEAD",
      `refs/heads/${kind}-${count}-${trial}`,
    ]);
    if (count === 1000) {
      await step("add-20-individually-existing", async () => {
        for (let i = 0; i < 20; i++) await git.add({ ...opts, filepath: `d0/f${i}.txt` });
      });
      await step("add-20-bulk-existing", () =>
        git.add({ ...opts, filepath: Array.from({ length: 20 }, (_, i) => `d0/f${i}.txt`) }),
      );
    }
    const cloneDir = vfs ? "/clone" : path.join(root, `clone-${kind}-${count}-${trial}`);
    await step("clone", async () => {
      await git.clone({
        fs: client,
        http,
        dir: cloneDir,
        url,
        ref: `${kind}-${count}-${trial}`,
        singleBranch: true,
      });
      assert.equal(await git.resolveRef({ fs: client, dir: cloneDir, ref: "HEAD" }), second);
    });
    // Outside timing: every cloned body must match, not just HEAD. Commit tree
    // identity also makes the two backends' fixture outcomes comparable.
    for (let i = 0; i < count; i++) {
      const filepath = `d${Math.floor(i / 100)}/f${i}.txt`;
      assert.deepEqual(
        Buffer.from(await client.promises.readFile(`${cloneDir}/${filepath}`)),
        Buffer.from(await client.promises.readFile(`${dir}/${filepath}`)),
      );
    }
    results.push({
      kind,
      count,
      trial,
      name: "verified-outcome",
      initialOid: first,
      changedOid: second,
      verifiedFiles: count,
    });
  } finally {
    vfs?.close();
  }
}
try {
  for (const count of (process.env.GIT_PROBE_COUNTS || "100,1000").split(",").map(Number))
    for (
      let trial = -Number(process.env.GIT_PROBE_WARMUPS || 0);
      trial < Number(process.env.GIT_PROBE_TRIALS || 3);
      trial++
    ) {
      const start = results.length;
      for (const kind of trial % 2 === 0 ? ["native", "vfs"] : ["vfs", "native"])
        await run(kind, count, trial);
      const outcomes = results.slice(start).filter((row) => row.name === "verified-outcome");
      assert.equal(outcomes[0].initialOid, outcomes[1].initialOid);
      assert.equal(outcomes[0].changedOid, outcomes[1].changedOid);
      if (trial < 0) results.splice(start);
    }
  // Compressed pack above 8 MiB even though every working-tree file is below it.
  let client;
  const largeStore = TieredFileContent ? new MemoryOpaqueStore() : undefined;
  const vfs = new NodeSqlFileSystem({
    ...(timingOnly ? {} : { onStatement: (q, n) => client?.observe(q, n) }),
    ...(largeStore ? { opaqueStore: largeStore } : {}),
  });
  client = instrument(
    createFsAdapter
      ? createFsAdapter(
          vfs,
          largeStore
            ? {
                content: new TieredFileContent(vfs, largeStore),
                maxReadFileBytes: 32 * 1024 * 1024,
              }
            : {},
        )
      : adapter(vfs),
  );
  const opts = { fs: client.fs, dir: "/large" };
  try {
    await client.fs.promises.mkdir("/large");
    await git.init({ ...opts, defaultBranch: "main" });
    for (let i = 0; i < 6; i++)
      await client.fs.promises.writeFile(`/large/random-${i}.bin`, randomBytes(2 * 1024 * 1024));
    await git.add({ ...opts, filepath: "." });
    const oid = await git.commit({ ...opts, message: "12 MiB random", author });
    for (const [name, fn] of [
      [
        "push-large",
        () => git.push({ ...opts, http, url: r.url, ref: "main", remoteRef: "large" }),
      ],
      [
        "clone-large",
        () => {
          execFileSync("git", [
            "--git-dir",
            r.remoteDir,
            "symbolic-ref",
            "HEAD",
            "refs/heads/large",
          ]);
          return git.clone({
            fs: client.fs,
            http,
            dir: "/large-clone",
            url: r.url,
            ref: "large",
            singleBranch: true,
          });
        },
      ],
      [
        "write-9MiB",
        () => client.fs.promises.writeFile("/large/too-large.bin", randomBytes(9 * 1024 * 1024)),
      ],
      ["diff-1200-lines", () => createLineDiff("a\n".repeat(1200), "b\n".repeat(1200))],
    ]) {
      client.reset();
      const start = performance.now();
      let error = null;
      try {
        const value = await fn();
        if (name === "push-large") {
          assert.equal(value.ok, true);
          assert.equal(
            execFileSync("git", ["--git-dir", r.remoteDir, "rev-parse", "refs/heads/large"], {
              encoding: "utf8",
            }).trim(),
            oid,
          );
        }
      } catch (e) {
        error = { code: e.code || e.name, message: e.message };
      }
      const m = client.get();
      m.queries = undefined;
      const row = {
        kind: "vfs",
        count: 6,
        trial: 0,
        name,
        ms: performance.now() - start,
        ...m,
        error,
      };
      results.push(row);
      console.log(JSON.stringify(row));
      const expected = {
        "push-large": null,
        "clone-large": TieredFileContent ? null : "EFBIG",
        "write-9MiB": TieredFileContent ? null : "EFBIG",
        "diff-1200-lines": "E2BIG",
      };
      assert.equal(error?.code ?? null, expected[name]);
    }
    if (largeStore) {
      assert.equal(await git.resolveRef({ fs: client.fs, dir: "/large-clone", ref: "HEAD" }), oid);
      for (let i = 0; i < 6; i++)
        assert.deepEqual(
          await client.fs.promises.readFile(`/large-clone/random-${i}.bin`),
          await client.fs.promises.readFile(`/large/random-${i}.bin`),
        );
      results.push({ kind: "vfs", name: "opaque-operation-counts", ...largeStore.operations });
    }
    execFileSync("git", ["--git-dir", r.remoteDir, "fsck", "--full"], { stdio: "pipe" });
    let clock = 1700000000000;
    const fixed = new NodeSqlFileSystem({ now: () => clock });
    try {
      const fs = createFsAdapter ? createFsAdapter(fixed) : adapter(fixed);
      fixed.mkdir("/race");
      const opt = { fs, dir: "/race" };
      await git.init({ ...opt, defaultBranch: "main" });
      await fs.promises.writeFile("/race/a", "old\n");
      await git.add({ ...opt, filepath: "a" });
      await git.commit({ ...opt, message: "race", author });
      clock += 100;
      await fs.promises.writeFile("/race/a", "new\n");
      const matrix = await git.statusMatrix(opt);
      const detected = matrix[0][1] !== matrix[0][2];
      results.push({
        kind: "vfs",
        name: "same-second-same-size-change",
        detected,
        matrix,
        before: "old",
        after: await fs.promises.readFile("/race/a", "utf8"),
      });
      console.log(JSON.stringify(results.at(-1)));
      assert.equal(detected, false);
    } finally {
      fixed.close();
    }
  } finally {
    vfs.close();
  }
} finally {
  await new Promise((resolve) => r.server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
  fs.writeFileSync(
    process.env.GIT_PROBE_OUTPUT || new URL("./git-workload-results.json", import.meta.url),
    `${JSON.stringify(
      {
        node: process.version,
        variant: process.env.GIT_PROBE_VARIANT || "baseline",
        timingOnly,
        gitEngine: JSON.parse(
          fs.readFileSync(
            path.join(path.dirname(require.resolve("isomorphic-git")), "package.json"),
            "utf8",
          ),
        ).version,
        nativeGit: execFileSync("git", ["--version"], { encoding: "utf8" }).trim(),
        cpu: os.cpus()[0]?.model,
        platform: os.platform(),
        arch: os.arch(),
        osVersion: os.version(),
        nativeVolume,
        protocolSha256: createHash("sha256")
          .update(fs.readFileSync(new URL(import.meta.url)))
          .digest("hex"),
        sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        sourceDiff: execFileSync("git", ["diff", "HEAD", "--", "src"], { encoding: "utf8" }),
        counts: (process.env.GIT_PROBE_COUNTS || "100,1000").split(",").map(Number),
        trials: Number(process.env.GIT_PROBE_TRIALS || 3),
        warmups: Number(process.env.GIT_PROBE_WARMUPS || 0),
        metadataCacheEntries: FsMetadataCache
          ? Number(process.env.GIT_PROBE_METADATA_ENTRIES || 4096)
          : 0,
        results,
      },
      null,
      2,
    )}\n`,
  );
}

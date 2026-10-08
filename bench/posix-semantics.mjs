/** Native filesystem oracle: run the same traces against POSIX-shaped promises. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const library = path.resolve(process.env.POSIX_LIBRARY || "dist");
const { NodeSqlFileSystem } = await import(pathToFileURL(path.join(library, "testing/node.js")));
const { createFsAdapter } = await import(pathToFileURL(path.join(library, "fs/index.js")));
const scenarios = [
  [
    "empty-file",
    async (f, p) => {
      await f.writeFile(p("a"), "");
      return (await f.stat(p("a"))).size;
    },
  ],
  [
    "overwrite-keeps-inode",
    async (f, p) => {
      await f.writeFile(p("a"), "old");
      const old = await f.stat(p("a"));
      await f.writeFile(p("a"), "new");
      return (await f.stat(p("a"))).ino === old.ino;
    },
  ],
  [
    "truncate-removes-tail",
    async (f, p) => {
      await f.writeFile(p("a"), "long body");
      await f.writeFile(p("a"), "x");
      return f.readFile(p("a"), "utf8");
    },
  ],
  [
    "append-creates",
    async (f, p) => {
      await f.writeFile(p("a"), "one", { flag: "a" });
      await f.writeFile(p("a"), "two", { flag: "a" });
      return f.readFile(p("a"), "utf8");
    },
  ],
  [
    "exclusive-existing",
    async (f, p) => {
      await f.writeFile(p("a"), "old");
      await f.writeFile(p("a"), "new", { flag: "wx" });
    },
  ],
  [
    "exclusive-dangling-link",
    async (f, p) => {
      await f.symlink("target", p("link"));
      await f.writeFile(p("link"), "new", { flag: "wx" });
    },
  ],
  [
    "append-dangling-link",
    async (f, p) => {
      await f.symlink("target", p("link"));
      await f.writeFile(p("link"), "new", { flag: "a" });
      return f.readFile(p("target"), "utf8");
    },
  ],
  [
    "file-trailing-slash",
    async (f, p) => {
      await f.writeFile(p("a"), "x");
      return f.stat(p("a/"));
    },
  ],
  [
    "lstat-link",
    async (f, p) => {
      await f.writeFile(p("target"), "x");
      await f.symlink("target", p("link"));
      return [(await f.lstat(p("link"))).isSymbolicLink(), (await f.stat(p("link"))).isFile()];
    },
  ],
  [
    "directory-link-trailing-slash",
    async (f, p) => {
      await f.mkdir(p("dir"));
      await f.symlink("dir", p("link"));
      return (await f.lstat(p("link/"))).isDirectory();
    },
  ],
  [
    "symlink-cycle",
    async (f, p) => {
      await f.symlink("b", p("a"));
      await f.symlink("a", p("b"));
      await f.stat(p("a"));
    },
  ],
  [
    "rmdir-nonempty",
    async (f, p) => {
      await f.mkdir(p("dir"));
      await f.writeFile(p("dir/a"), "x");
      await f.rmdir(p("dir"));
    },
  ],
  [
    "unlink-directory",
    async (f, p) => {
      await f.mkdir(p("dir"));
      await f.unlink(p("dir"));
    },
  ],
  [
    "rename-missing-same-path",
    async (f, p) => {
      await f.rename(p("missing"), p("missing"));
    },
  ],
  [
    "rename-file-directory",
    async (f, p) => {
      await f.writeFile(p("a"), "x");
      await f.mkdir(p("dir"));
      await f.rename(p("a"), p("dir"));
    },
  ],
  [
    "rename-directory-file",
    async (f, p) => {
      await f.writeFile(p("a"), "x");
      await f.mkdir(p("dir"));
      await f.rename(p("dir"), p("a"));
    },
  ],
  [
    "rename-directory-nonempty",
    async (f, p) => {
      await f.mkdir(p("a"));
      await f.mkdir(p("b"));
      await f.writeFile(p("b/file"), "x");
      await f.rename(p("a"), p("b"));
    },
  ],
  [
    "rename-keeps-inode",
    async (f, p) => {
      await f.writeFile(p("a"), "one");
      await f.writeFile(p("b"), "two");
      const old = await f.stat(p("a"));
      await f.rename(p("a"), p("b"));
      return [(await f.stat(p("b"))).ino === old.ino, await f.readFile(p("b"), "utf8")];
    },
  ],
  [
    "rename-replaces-link",
    async (f, p) => {
      await f.writeFile(p("a"), "one");
      await f.writeFile(p("target"), "two");
      await f.symlink("target", p("b"));
      await f.rename(p("a"), p("b"));
      return [await f.readFile(p("b"), "utf8"), await f.readFile(p("target"), "utf8")];
    },
  ],
  [
    "rename-through-parent-link",
    async (f, p) => {
      await f.mkdir(p("dir"));
      await f.symlink("dir", p("link"));
      await f.writeFile(p("link/a"), "one");
      await f.rename(p("link/a"), p("link/b"));
      return f.readFile(p("dir/b"), "utf8");
    },
  ],
  [
    "chmod-preserves-mtime",
    async (f, p) => {
      await f.writeFile(p("a"), "x");
      await f.utimes(p("a"), 10, 10);
      const before = await f.stat(p("a"));
      await f.chmod(p("a"), 0o600);
      return (await f.stat(p("a"))).mtimeMs === before.mtimeMs;
    },
  ],
  [
    "chmod-advances-ctime",
    async (f, p) => {
      await f.writeFile(p("a"), "x");
      const before = await f.stat(p("a"));
      await new Promise((resolve) => setTimeout(resolve, 25));
      await f.chmod(p("a"), 0o600);
      return (await f.stat(p("a"))).ctimeMs > before.ctimeMs;
    },
  ],
  [
    "rename-preserves-file-mtime",
    async (f, p) => {
      await f.writeFile(p("a"), "x");
      await f.utimes(p("a"), 10, 10);
      const before = await f.stat(p("a"));
      await f.rename(p("a"), p("b"));
      return (await f.stat(p("b"))).mtimeMs === before.mtimeMs;
    },
  ],
  [
    "child-create-updates-parent-mtime",
    async (f, p) => {
      await f.mkdir(p("dir"));
      await f.utimes(p("dir"), 10, 10);
      const before = await f.stat(p("dir"));
      await f.writeFile(p("dir/a"), "x");
      return (await f.stat(p("dir"))).mtimeMs > before.mtimeMs;
    },
  ],
  [
    "symlink-dotdot",
    async (f, p) => {
      await f.mkdir(p("dir/sub"), { recursive: true });
      await f.writeFile(p("dir/file"), "target");
      await f.writeFile(p("file"), "lexical");
      await f.symlink("dir/sub", p("link"));
      return f.readFile(p("link/../file"), "utf8");
    },
  ],
  [
    "file-dotdot",
    async (f, p) => {
      await f.writeFile(p("a"), "x");
      return (await f.stat(p("a/.."))).isDirectory();
    },
  ],
  [
    "file-dot",
    async (f, p) => {
      await f.writeFile(p("a"), "x");
      return (await f.stat(p("a/."))).isFile();
    },
  ],
  [
    "missing-dotdot",
    async (f, p) => {
      await f.writeFile(p("a"), "x");
      return f.readFile(p("missing/../a"), "utf8");
    },
  ],
  [
    "nested-link-target-dotdot",
    async (f, p) => {
      await f.mkdir(p("dir/sub"), { recursive: true });
      await f.writeFile(p("dir/file"), "target");
      await f.writeFile(p("file"), "lexical");
      await f.symlink("dir/sub", p("link"));
      await f.symlink("link/../file", p("nested"));
      return f.readFile(p("nested"), "utf8");
    },
  ],
  [
    "lstat-link-dot",
    async (f, p) => {
      await f.mkdir(p("dir"));
      await f.symlink("dir", p("link"));
      return (await f.lstat(p("link/."))).isDirectory();
    },
  ],
  [
    "open-read-after-rename",
    async (f, p) => {
      await f.writeFile(p("a"), "old");
      const h = await f.open(p("a"), "r");
      try {
        await f.rename(p("a"), p("b"));
        return await h.readFile("utf8");
      } finally {
        await h.close();
      }
    },
  ],
  [
    "open-read-after-unlink",
    async (f, p) => {
      await f.writeFile(p("a"), "old");
      const h = await f.open(p("a"), "r");
      try {
        await f.unlink(p("a"));
        return await h.readFile("utf8");
      } finally {
        await h.close();
      }
    },
  ],
  [
    "open-handles-share-writes",
    async (f, p) => {
      await f.writeFile(p("a"), "old");
      const a = await f.open(p("a"), "r+");
      const b = await f.open(p("a"), "r+");
      try {
        await a.write("new", 0, "utf8");
        return await b.readFile("utf8");
      } finally {
        await a.close();
        await b.close();
      }
    },
  ],
  [
    "hardlink-shares-content",
    async (f, p) => {
      await f.writeFile(p("a"), "old");
      await f.link(p("a"), p("b"));
      await f.writeFile(p("b"), "new");
      return [
        (await f.stat(p("a"))).ino === (await f.stat(p("b"))).ino,
        (await f.stat(p("a"))).nlink,
        await f.readFile(p("a"), "utf8"),
      ];
    },
  ],
  [
    "hardlink-open-after-original-unlink",
    async (f, p) => {
      await f.writeFile(p("a"), "old");
      await f.link(p("a"), p("b"));
      const h = await f.open(p("a"), "r");
      try {
        await f.unlink(p("a"));
        return await h.readFile("utf8");
      } finally {
        await h.close();
      }
    },
  ],
  [
    "hardlink-rename-same-inode",
    async (f, p) => {
      await f.writeFile(p("a"), "old");
      await f.link(p("a"), p("b"));
      await f.rename(p("a"), p("b"));
      return (await f.stat(p("a"))).nlink;
    },
  ],
  [
    "hardlink-symlink-inode",
    async (f, p) => {
      await f.symlink("missing", p("a"));
      await f.link(p("a"), p("b"));
      return [(await f.lstat(p("b"))).nlink, await f.readlink(p("b"))];
    },
  ],
  [
    "directory-link-count",
    async (f, p) => {
      await f.mkdir(p("a"));
      await f.mkdir(p("a/sub"));
      const old = (await f.stat(p("a"))).nlink;
      await f.rename(p("a/sub"), p("sub"));
      return [old, (await f.stat(p("a"))).nlink];
    },
  ],
  [
    "handle-hole-write",
    async (f, p) => {
      const h = await f.open(p("a"), "w+");
      try {
        await h.write("x", 3);
        return Array.from(await f.readFile(p("a")));
      } finally {
        await h.close();
      }
    },
  ],
  [
    "handle-truncate-extend",
    async (f, p) => {
      await f.writeFile(p("a"), "abc");
      const h = await f.open(p("a"), "r+");
      try {
        await h.truncate(1);
        await h.truncate(3);
        return Array.from(await f.readFile(p("a")));
      } finally {
        await h.close();
      }
    },
  ],
  [
    "handle-explicit-position-cursor",
    async (f, p) => {
      await f.writeFile(p("a"), "abcd");
      const h = await f.open(p("a"), "r+");
      try {
        const out = new Uint8Array(1);
        await h.read(out, 0, 1, 2);
        await h.read(out, 0, 1, null);
        return Array.from(out);
      } finally {
        await h.close();
      }
    },
  ],
  [
    "handle-shared-write-after-last-unlink",
    async (f, p) => {
      await f.writeFile(p("a"), "old");
      const a = await f.open(p("a"), "r+");
      const b = await f.open(p("a"), "r+");
      try {
        await f.unlink(p("a"));
        await a.write("NEW", 0);
        return [(await b.stat()).nlink, await b.readFile("utf8")];
      } finally {
        await a.close();
        await b.close();
      }
    },
  ],
  [
    "handle-sync",
    async (f, p) => {
      const h = await f.open(p("a"), "w+");
      try {
        await h.writeFile("ok");
        await h.sync();
        await h.datasync();
        return await f.readFile(p("a"), "utf8");
      } finally {
        await h.close();
      }
    },
  ],

  [
    "directory-nlink-mixed-replacement",
    async (f, p) => {
      await f.mkdir(p("left/sub"), { recursive: true });
      await f.mkdir(p("right"));
      const links = [];
      links.push((await f.stat(p(""))).nlink);
      await f.writeFile(p("left/file"), "x");
      links.push((await f.stat(p("left"))).nlink);
      await f.rename(p("left/sub"), p("right"));
      links.push((await f.stat(p("left"))).nlink, (await f.stat(p(""))).nlink);
      await f.rm(p("right"), { recursive: true });
      links.push((await f.stat(p(""))).nlink);
      return links;
    },
  ],
  [
    "descriptor-overwrite-and-truncate-boundaries",
    async (f, p) => {
      await f.writeFile(p("a"), new Uint8Array(65537).fill(65));
      const h = await f.open(p("a"), "r+");
      const observed = [];
      try {
        await h.write(new Uint8Array(32768).fill(66), 0, 32768, 1);
        const edge = new Uint8Array(4);
        await h.read(edge, 0, 4, 32767);
        observed.push(Array.from(edge));
        for (const size of [65537, 32769, 32768, 32767, 1, 0, 0, 5]) {
          await h.truncate(size);
          observed.push((await h.stat()).size);
        }
        observed.push(Array.from(await h.readFile()));
      } finally {
        await h.close();
      }
      return observed;
    },
  ],
  [
    "linked-descriptor-truncate-after-unlink",
    async (f, p) => {
      await f.writeFile(p("a"), new Uint8Array(65537).fill(65));
      await f.link(p("a"), p("alias"));
      const a = await f.open(p("a"), "r+");
      const b = await f.open(p("alias"), "r+");
      const observed = [];
      try {
        await a.truncate(32769);
        observed.push((await b.stat()).size, (await f.stat(p("alias"))).size);
        await f.unlink(p("a"));
        await f.unlink(p("alias"));
        await a.write(new Uint8Array(32768).fill(66), 0, 32768, 0);
        await b.truncate(4);
        observed.push((await a.stat()).nlink, Array.from(await a.readFile()));
      } finally {
        await a.close();
        await b.close();
      }
      return observed;
    },
  ],
];

async function observe(kind, operation) {
  const root =
    kind === "native"
      ? await fs.mkdtemp(path.join(os.tmpdir(), "cf-vfs-posix-oracle-"))
      : "/oracle";
  const vfs = kind === "vfs" ? new NodeSqlFileSystem() : undefined;
  const f = vfs ? createFsAdapter(vfs).promises : fs;
  const trace = [];
  if (vfs)
    f.utimes = async (name, _atime, mtime) => {
      vfs.setMetadata(name, { modifiedAtMs: mtime * 1000 });
    };
  if (vfs && process.env.POSIX_HANDLE_PROTOTYPE) {
    const { experimentalOpen } = await import(
      pathToFileURL(path.resolve(process.env.POSIX_HANDLE_PROTOTYPE))
    );
    f.open = (name, flags) => experimentalOpen(vfs, f, name, flags);
  }
  const p = (name) => `${root}/${name}`;
  try {
    await f.mkdir(root, { recursive: true });
    let outcome;
    try {
      outcome = { value: (await operation(f, p)) ?? null };
    } catch (error) {
      outcome = { error: error.code || error.name };
    }
    // Snapshot post-failure state as well as return codes.
    const walk = async (directory) => {
      for (const name of (await f.readdir(directory)).sort()) {
        const full = `${directory}/${name}`;
        const stat = await f.lstat(full);
        const relative = full.slice(root.length + 1);
        if (stat.isDirectory()) {
          trace.push([relative, "directory"]);
          await walk(full);
        } else if (stat.isSymbolicLink()) trace.push([relative, "link", await f.readlink(full)]);
        else trace.push([relative, "file", await f.readFile(full, "utf8")]);
      }
    };
    await walk(root);
    return { ...outcome, state: trace };
  } finally {
    if (vfs) vfs.close();
    else await fs.rm(root, { recursive: true, force: true });
  }
}
const checking = process.argv.includes("--check");
const oracle = checking
  ? JSON.parse(
      await fs.readFile(
        new URL("../test/fixtures/posix-linux-oracle.json", import.meta.url),
        "utf8",
      ),
    )
  : undefined;
const results = [];
for (const [name, operation] of scenarios) {
  const native = oracle ? oracle.cases[name] : await observe("native", operation);
  assert.notEqual(native, undefined, `missing native oracle: ${name}`);
  const vfs = await observe("vfs", operation);
  let equal = true;
  try {
    assert.deepEqual(vfs, native);
  } catch {
    equal = false;
  }
  results.push({ name, equal, native, vfs });
}
await fs.writeFile(
  process.env.POSIX_OUTPUT || "/tmp/cf-vfs-posix-semantics.json",
  `${JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    matches: results.filter((row) => row.equal).length,
    total: results.length,
    differences: results.filter((row) => !row.equal).map((row) => row.name),
  }),
);

if (checking) {
  assert.deepEqual(
    results.filter((row) => !row.equal).map((row) => row.name),
    oracle.knownDifferences,
    "POSIX compatibility changed; review the Linux trace rather than updating the baseline blindly",
  );
  assert.deepEqual(
    Object.keys(oracle.cases),
    scenarios.map(([name]) => name),
  );
}

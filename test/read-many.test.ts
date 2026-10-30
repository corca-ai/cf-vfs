import { expect, it } from "vitest";
import { VfsError } from "../src/core/errors.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { Shell } from "../src/shell/shell.js";
import type { ShellLimits } from "../src/shell/types.js";
import type { VirtualFileSystem } from "../src/vfs/types.js";
import { createTestFileSystem, withoutBulkReads } from "./helpers/node-sql.js";

function joinBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

async function text(view: VirtualFileSystem, path: string): Promise<string> {
  return await new Response(view.readFile(path).stream).text();
}

it("returns readFile's stats and bodies, preserving order and duplicates", async () => {
  const fs = createTestFileSystem({ chunkBytes: 4 });
  fs.mkdir("/dir");
  await fs.writeFile("/dir/a", "first body spans chunks");
  await fs.writeFile("/dir/b", "");
  await fs.writeFile("/c", "c");
  const paths = ["/dir/a", "/missing", "/dir", "/c", "/dir/b", "/dir/a", "/dir/a/child"];
  for (const view of [fs, fs.forCredentials({ uid: 1000, gid: 1000 })]) {
    const results = view.readMany?.(paths) ?? [];
    expect(results.map((read) => read?.stat)).toEqual([
      view.stat("/dir/a"),
      undefined,
      undefined,
      view.stat("/c"),
      view.stat("/dir/b"),
      view.stat("/dir/a"),
      undefined,
    ]);
    const decoder = new TextDecoder();
    expect(
      results.map((read) =>
        read === undefined ? undefined : decoder.decode(joinBytes(read.chunks)),
      ),
    ).toEqual([
      await text(view, "/dir/a"),
      undefined,
      undefined,
      "c",
      "",
      await text(view, "/dir/a"),
      undefined,
    ]);
  }
});

it("leaves refused, opaque and linked entries to readFile", async () => {
  const { MemoryOpaqueStore } = await import("../src/testing/opaque-store.js");
  const { putOpaque } = await import("../src/vfs/opaque.js");
  const store = new MemoryOpaqueStore();
  const fs = createTestFileSystem({ opaqueStore: store });
  fs.mkdir("/secret", false, 0o700);
  await fs.writeFile("/secret/file", "hidden");
  await fs.writeFile("/private", "mine", { mode: 0o600 });
  await fs.writeFile("/open", "open");
  await putOpaque(fs, store, "/opaque", "body", { contentType: "text/plain" });
  const user = fs.forCredentials({ uid: 1000, gid: 1000 });
  expect(user.readMany?.(["/secret/file", "/private", "/open", "/opaque"])).toEqual([
    undefined,
    undefined,
    { stat: user.stat("/open"), chunks: [new TextEncoder().encode("open")] },
    undefined,
  ]);
  fs.setMetadata("/secret", { mode: 0o755 });
  expect(user.readMany?.(["/secret/file", "/open"])?.[0]?.stat).toEqual(user.stat("/secret/file"));
  fs.symlink("/alias", "/open");
  expect(fs.readMany(["/open", "/c"])).toEqual([undefined, undefined]);
});

it("reads ordinary paths in two statements per batch within the byte allowance", async () => {
  let statements = 0;
  const fs = createTestFileSystem({ onStatement: () => statements++ });
  await fs.writeFiles(Array.from({ length: 100 }, (_, i) => ({ path: `/f${i}`, body: "xxxx" })));
  const paths = Array.from({ length: 100 }, (_, i) => `/f${i}`);
  statements = 0;
  expect(fs.readMany([])).toEqual([]);
  expect(fs.readMany(paths).every((read) => read !== undefined)).toBe(true);
  expect(statements).toBe(4);
  const bounded = fs.readMany(paths, { maxBytes: 10 });
  expect(bounded.filter((read) => read !== undefined)).toHaveLength(2);
  expect(() => fs.readMany(Array(1001).fill("/"))).toThrow(VfsError);
  expect(() => Reflect.apply(fs.readMany, fs, [Array(2)])).toThrow(
    expect.objectContaining({ code: "EINVAL" }),
  );
});

it("gives grep -r the answers of per-file reads in fewer statements", async () => {
  const pages = Array.from({ length: 150 }, (_, i) => ({
    path: `/w/${i % 3}/p${i}.md`,
    body: i % 7 === 0 ? `title ${i}\nsee [[hit]]\n` : `title ${i}\n`,
  }));
  const run = async (bulk: boolean, chunkBytes?: number) => {
    let statements = 0;
    const fs = createTestFileSystem({
      onStatement: () => statements++,
      ...(chunkBytes === undefined ? {} : { chunkBytes }),
    });
    await fs.writeFiles(pages, { createParents: true });
    await fs.writeFile("/w/1/secret.md", "[[hit]]\n", { mode: 0o600 });
    // Invalid UTF-8 past the first chunk fails after the lines before it.
    const bad = new TextEncoder().encode("hit one\nhit two\nx\xff\nhit three\n");
    bad[18] = 0xff;
    await fs.writeFile("/w/2/bad.md", bad);
    const fileSystem = bulk ? fs : withoutBulkReads(fs);
    const shell = new Shell({ fileSystem, commands: defaultShellCommands });
    statements = 0;
    const result = await shell.executeText({
      credentials: { uid: 1000, gid: 1000 },
      cwd: "/",
      script: "grep -rn hit /w/0 /w/1; grep -rc title /w/0 | tail -2; grep -rn hit /w/2",
    });
    return { result, statements };
  };
  const bulk = await run(true);
  const perFile = await run(false);
  expect(bulk.result).toEqual(perFile.result);
  expect(bulk.result.stderr).toContain("/w/2/bad.md");
  expect((await run(true, 8)).result).toEqual((await run(false, 8)).result);
  expect(bulk.result.stderr).toContain("/w/1/secret.md");
  expect(bulk.result.stdout).toContain("/w/0/p21.md:2:see [[hit]]");
  expect(bulk.statements * 4).toBeLessThan(perFile.statements);
});

it("skips unselectable bulk bodies with the results and failures of reading their lines", async () => {
  const encoder = new TextEncoder();
  const invalid = encoder.encode("plain words\nmore x\n");
  invalid[17] = 0xff;
  const files: Record<string, Uint8Array | string> = {
    "/w/a.md": "owner: ann\nsee [[Hit]] and hit\n",
    "/w/b.md": "nothing here\n".repeat(20),
    "/w/c.md": "short\nlonger line\n",
    "/long/c.md": `${"long ".repeat(30)}\nshort\n`,
    "/w/d.md": "﻿bom first line\nowner: bob\n",
    "/w/e.md": "no newline at end",
    "/w/f.md": "",
    "/bad/g.md": invalid,
  };
  const scripts = [
    "grep -rlF hit /w",
    "grep -rLF hit /w",
    "grep -rc '^owner:' /w",
    "grep -rciF HIT /w",
    "grep -rnw hit /w",
    "grep -rx 'short' /w",
    "grep -rv words /w",
    "grep -rm0 -c words /w",
    "grep -rE 'own(er)?' /w",
    "grep -rF -e absent -e bob /w",
    "grep -rc -e absent -e 'x.y' /w",
    "grep -rlF hit /bad",
    "grep -rcF short /long /w",
    "grep -rlF absent /long",
  ];
  const run = async (bulk: boolean, chunkBytes: number, limits: Partial<ShellLimits>) => {
    const fs = createTestFileSystem({ chunkBytes });
    for (const [path, body] of Object.entries(files)) {
      await fs.writeFile(path, body, { createParents: true });
    }
    const shell = new Shell({
      fileSystem: bulk ? fs : withoutBulkReads(fs),
      commands: defaultShellCommands,
      limits,
    });
    const results = [];
    for (const script of scripts) {
      results.push(await shell.executeText({ cwd: "/", script: `${script}; echo "status $?"` }));
    }
    return results;
  };
  const cases: [number, Partial<ShellLimits>][] = [
    [4096, {}],
    [5, {}],
    [5, { maxLineBytes: 40 }],
    [4096, { maxBufferedRecords: 5 }],
  ];
  for (const [chunkBytes, limits] of cases) {
    expect(await run(true, chunkBytes, limits)).toEqual(await run(false, chunkBytes, limits));
  }
});

it("leaves paths outside the readable roots to readFile's refusal", async () => {
  const run = async (bulk: boolean, link: boolean) => {
    const fs = createTestFileSystem();
    await fs.writeFiles(
      ["/w/in/a.md", "/w/in/b.md", "/w/out/c.md", "/w/out/d.md"].map((path) => ({
        path,
        body: "hit\n",
      })),
      { createParents: true },
    );
    if (link) fs.symlink("/w/in/escape", "/w/out");
    const shell = new Shell({
      fileSystem: bulk ? fs : withoutBulkReads(fs),
      commands: defaultShellCommands,
      policy: { readRoots: ["/w/in"] },
    });
    return await shell.executeText({ cwd: "/", script: "grep -r hit /w/in; grep -r hit /w" });
  };
  for (const link of [false, true]) {
    const bulk = await run(true, link);
    expect(bulk).toEqual(await run(false, link));
    expect(bulk.stdout).toContain("/w/in/a.md:hit");
    expect(bulk.stdout).not.toContain("/w/out/c.md:hit");
  }
});

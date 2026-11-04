import { expect, it } from "vitest";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { Shell } from "../src/shell/shell.js";
import { createTestFileSystem, withoutBulkReads } from "./helpers/node-sql.js";

// cut, uniq, nl, fold and xargs take a bulk body's lines synchronously and a stream's a
// chunk at a time, writing through a buffer that awaits only its sink; every
// form of input must print what reading each line in turn printed.
const SCRIPTS = [
  "cut -c1-6 /w/*.md",
  "cut -d' ' -f2 /w/*.md",
  "cut -d' ' -f2 -s /w/*.md",
  "uniq /w/*.md",
  "uniq -c /w/*.md",
  "uniq -d /w/*.md",
  "uniq -u -i /w/*.md",
  "nl /w/*.md",
  "cat /w/*.md | cut -c2-4",
  "cat /w/*.md | uniq -c",
  "cat /w/*.md | nl",
  "uniq /w/a.md /x/bad.md",
  "cut -c1 /w/a.md /x/missing.md /w/b.md",
  "nl /x/bom.md /x/unterminated.md",
  "cut -c1-3 /x/huge-line.md",
  "uniq /x/long.md | head -2",
  "nl /x/long.md | head -3",
  "cut -c1-2 /x/long.md | tail -1",
  // Past the writer's 64 KiB buffer, where a write awaits its sink.
  "nl /x/long.md /x/long.md | tail -2",
  "uniq -c /x/long.md /x/long.md /x/long.md | wc -c",
  "cut -c1-5 /x/long.md /x/long.md | tail -1",
  "cat /x/long.md /x/long.md | nl | wc -c",
  "fold -w 4 /w/*.md",
  "cat /w/*.md | fold -w 3",
  "fold -w 2 /x/bom.md /x/unterminated.md",
  "fold -w 7 /x/long.md /x/long.md | tail -2",
  "fold -w 3 /x/bad.md",
  "fold -w 5 /x/huge-line.md | wc -l",
  "cat /w/*.md | xargs echo",
  "cat /w/*.md | xargs -n 3 echo | tail -2",
  "cat /x/unterminated.md | xargs -n 1 echo",
  "cat /x/long.md /x/long.md | xargs echo | wc -c",
  "cat /x/bad.md | xargs echo",
  "printf 'a b\\0c\\n\\0' | xargs -0 -n 1 echo",
];

async function run(bulk: boolean, chunkBytes: number) {
  const fs = createTestFileSystem({ chunkBytes });
  const files = Array.from({ length: 30 }, (_, i) => ({
    path: `/w/${String.fromCharCode(97 + (i % 26))}${i >= 26 ? i : ""}.md`,
    body: `title ${i}\n${i % 3 === 0 ? "same line\nsame line\nSAME LINE\n" : "plain é line\n\n"}x ${"y".repeat(i)}\n`,
  }));
  await fs.writeFiles(files, { createParents: true });
  await fs.mkdir("/x");
  await fs.writeFile("/x/bad.md", Uint8Array.of(0x68, 0x69, 0x0a, 0xff, 0x0a));
  await fs.writeFile("/x/bom.md", "﻿first\nsecond\n");
  await fs.writeFile("/x/unterminated.md", "a\nb");
  await fs.writeFile("/x/huge-line.md", `${"x".repeat(9000)}\nx\n`);
  await fs.writeFile(
    "/x/long.md",
    Array.from({ length: 5000 }, (_, i) => `row ${Math.floor(i / 3)}\n`).join(""),
  );
  const shell = new Shell({
    fileSystem: bulk ? fs : withoutBulkReads(fs),
    commands: defaultShellCommands,
    limits: { maxLineBytes: 8192 },
  });
  const results = [];
  for (const script of SCRIPTS) {
    results.push(await shell.executeText({ cwd: "/", script: `${script}; echo "status $?"` }));
  }
  return results;
}

it("prints from bulk bodies and streams what reading each line in turn printed", async () => {
  for (const chunkBytes of [4096, 7]) {
    const bulk = await run(true, chunkBytes);
    expect(bulk).toEqual(await run(false, chunkBytes));
    expect(bulk[4]?.stdout).toContain("      2 same line");
    expect(bulk.some((result) => result.stderr.includes("not valid UTF-8"))).toBe(true);
    expect(bulk.some((result) => result.stderr.includes("line byte limit"))).toBe(true);
    expect(bulk[SCRIPTS.indexOf("nl /x/long.md /x/long.md | tail -2")]?.stdout).toBe(
      "  9999\trow 1666\n 10000\trow 1666\nstatus 0\n",
    );
  }
});

it("xargs keeps a value that spans lines or ends the input", async () => {
  const fs = createTestFileSystem({});
  const shell = new Shell({ fileSystem: fs, commands: defaultShellCommands });
  const output = async (script: string) => (await shell.executeText({ cwd: "/", script })).stdout;

  expect(await output("printf 'a b\\n  c\\nd' | xargs -n 1 echo")).toBe("a\nb\nc\nd\n");
  expect(await output("printf 'a\\nb\\0c\\0d' | xargs -0 -n 1 echo")).toBe("a\nb\nc\nd\n");
  expect(await output("printf '\\0a\\0' | xargs -0 -n 1 echo x")).toBe("x \nx a\n");
});

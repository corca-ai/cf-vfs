import { expect, it } from "vitest";
import { awkCommand } from "../src/shell/commands/awk.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { Shell } from "../src/shell/shell.js";
import { createTestFileSystem, withoutBulkReads } from "./helpers/node-sql.js";

// awk runs a bulk-read body's records synchronously and awaits only a flush
// that reaches its sink; every program must print what reading each file as
// a stream prints, including when output passes the 64 KiB slab.
const SCRIPTS = [
  "awk '{ print FILENAME, FNR, NR, $1 }' /w/*.md",
  "awk 'FNR == 1' /w/*.md",
  "awk '/hit/ { n++ } END { print n }' /w/*.md",
  "awk '{ print $0 }' /w/*.md | wc -c",
  'awk \'{ printf "%s|", $2 } END { print "" }\' /w/*.md',
  "awk 'NR == 7 { exit 3 } { print }' /w/*.md",
  'awk \'{ print > "/out" } END { close("/out") }\' /w/a.md /w/b.md; cat /out',
  'awk \'{ print "err " NR > "/dev/stderr"; print "out " NR }\' /w/a.md',
  'awk \'BEGIN { print "start" } { print length($0) } END { print "end" }\' /w/*.md',
  "awk '{ print }' /x/big.md | tail -2",
  "awk '{ print; print }' /x/big.md | wc -l",
  "awk 'END { print NR }' /x/big.md /w/a.md",
  "awk '{ print }' /x/bad.md /w/a.md",
  "awk '{ print }' /w/a.md | head -1",
  "awk -F: '{ print $2 }' /w/*.md",
];

async function run(bulk: boolean, chunkBytes: number) {
  const fs = createTestFileSystem({ chunkBytes });
  const files = Array.from({ length: 30 }, (_, i) => ({
    path: `/w/${String.fromCharCode(97 + (i % 26))}${i >= 26 ? i : ""}.md`,
    body: `title ${i}\n${i % 3 === 0 ? `see:hit ${i}\n` : "plain line\n"}${"x".repeat(i)}`,
  }));
  await fs.writeFiles(files, { createParents: true });
  await fs.mkdir("/x");
  await fs.writeFile(
    "/x/big.md",
    Array.from({ length: 3000 }, (_, i) => `line ${i} ${"y".repeat(40)}\n`).join(""),
  );
  await fs.writeFile("/x/bad.md", Uint8Array.of(0x61, 0x0a, 0xff, 0x0a));
  const shell = new Shell({
    fileSystem: bulk ? fs : withoutBulkReads(fs),
    commands: [...defaultShellCommands, awkCommand],
  });
  const results = [];
  for (const script of SCRIPTS) {
    results.push(await shell.executeText({ cwd: "/", script: `${script}; echo "status $?"` }));
  }
  return results;
}

it("prints from bulk-read bodies what reading each file as a stream prints", async () => {
  for (const chunkBytes of [4096, 7]) {
    const bulk = await run(true, chunkBytes);
    expect(bulk).toEqual(await run(false, chunkBytes));
    expect(bulk[0]?.stdout).toContain("/w/a.md 1 1 title");
    expect(bulk[10]?.stdout).toContain("6000");
  }
});

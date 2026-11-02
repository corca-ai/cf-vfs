import { expect, it } from "vitest";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { Shell } from "../src/shell/shell.js";
import { createTestFileSystem, withoutBulkReads } from "./helpers/node-sql.js";

// sed takes the records of a bulk-read body synchronously and awaits only
// output that reaches its sink or a record that is not at hand; every script
// must print what reading each file as a stream prints.
const SCRIPTS = [
  "sed -n 's/hit/HIT/p' /w/*.md",
  "sed 's/plain/PLAIN/' /w/a.md /w/b.md",
  "sed -n '$p' /w/*.md",
  "sed -n '$=' /w/*.md",
  "sed '1d;$d' /w/a.md /w/b.md /w/c.md",
  "sed -n '/title 3/,/title 6/p' /w/*.md",
  "sed -n '2,$p' /w/a.md",
  "sed 'n;d' /w/*.md",
  "sed -n 'N;P' /w/*.md",
  "sed '$!N;s/\\n/ | /' /w/*.md",
  "sed '/hit/{h;d};${G}' /w/*.md",
  "sed '1i head' /w/a.md; sed '$a tail' /w/a.md /w/b.md",
  "sed '/plain/c changed' /w/*.md",
  "sed 'y/abc/xyz/' /w/a.md",
  "sed 5q /w/*.md",
  "sed 3Q /w/*.md",
  "sed -n '/hit/{=;p}' /w/*.md",
  "sed 'D' /w/a.md",
  "sed 's/x/y/g' /x/big.md | tail -2",
  "sed 'p' /x/big.md | wc -l",
  "sed -n '$p' /x/noeol.md /x/noeol.md",
  "sed 's/a/b/' /x/bad.md /w/a.md",
  "sed 's/title/T/' /w/a.md | head -1",
  "cat /w/a.md | sed -n '$p' - /w/b.md",
  "sed -n '$p' /w/a.md /x/empty.md",
  "sed -n '$=' /x/empty.md /w/a.md",
  "sed '$!N;P;D' /w/a.md /x/empty.md /w/b.md",
  "cp /w/a.md /w/edit.md; sed -i 's/title/TITLE/;$a end' /w/edit.md; cat /w/edit.md",
];

async function run(bulk: boolean, chunkBytes: number) {
  const fs = createTestFileSystem({ chunkBytes });
  const files = Array.from({ length: 30 }, (_, i) => ({
    path: `/w/${String.fromCharCode(97 + (i % 26))}${i >= 26 ? i : ""}.md`,
    body: `title ${i}\n${i % 3 === 0 ? `see hit ${i}\n` : "plain line\n"}${"x".repeat(i)}\n`,
  }));
  await fs.writeFiles(files, { createParents: true });
  await fs.mkdir("/x");
  await fs.writeFile(
    "/x/big.md",
    Array.from({ length: 3000 }, (_, i) => `line ${i} ${"x".repeat(40)}\n`).join(""),
  );
  await fs.writeFile("/x/noeol.md", "one\ntwo");
  await fs.writeFile("/x/empty.md", "");
  await fs.writeFile("/x/bad.md", Uint8Array.of(0x61, 0x0a, 0xff, 0x0a));
  const shell = new Shell({
    fileSystem: bulk ? fs : withoutBulkReads(fs),
    commands: defaultShellCommands,
  });
  const results = new Map<string, Awaited<ReturnType<typeof shell.executeText>>>();
  for (const script of SCRIPTS) {
    results.set(
      script,
      await shell.executeText({ cwd: "/", script: `${script}; echo "status $?"` }),
    );
  }
  return results;
}

it("prints from bulk-read bodies what reading each file as a stream prints", async () => {
  for (const chunkBytes of [4096, 7]) {
    const bulk = await run(true, chunkBytes);
    expect(bulk).toEqual(await run(false, chunkBytes));
    expect(bulk.get("sed -n 's/hit/HIT/p' /w/*.md")?.stdout).toContain("see HIT 0");
    expect(bulk.get("sed 'p' /x/big.md | wc -l")?.stdout).toContain("6000");
  }
});

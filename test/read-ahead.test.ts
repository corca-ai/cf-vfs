import { expect, it } from "vitest";
import { awkCommand } from "../src/shell/commands/awk.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { ReadAhead } from "../src/shell/commands/read-ahead.js";
import { Shell } from "../src/shell/shell.js";
import type { ShellCommandContext } from "../src/shell/types.js";
import { createTestFileSystem, withoutBulkReads } from "./helpers/node-sql.js";

const SCRIPTS = [
  "cat /w/*.md | md5sum",
  "cat /w/a.md /w/missing.md /w/b.md",
  "cat /w/a.md - /w/b.md < /w/c.md",
  "cat -n /w/a.md /w/b.md",
  "wc /w/*.md",
  "wc -l /w/a.md /w/a.md /w/missing.md /w/c.md",
  "grep -n hit /w/*.md /w/missing.md",
  "grep -c '^title' /w/*.md",
  "grep -lF hit - /w/a.md < /w/b.md",
  "sed -n '$=' /w/*.md",
  "awk 'FNR == 1 { print FILENAME }' /w/*.md",
  "head -n 1 /w/a.md /w/b.md; tail -n 1 /w/c.md /w/d.md",
  "uniq /w/a.md /w/b.md; cut -c1-4 /w/*.md | sort | uniq -c",
  "nl /w/a.md /w/b.md; fold -w 7 /w/c.md /w/d.md",
  "md5sum /w/*.md",
  // A command that writes a later operand must see what it wrote.
  'awk \'FNR == 1 { print "rewritten" > "/w/d.md"; close("/w/d.md") } { print }\' /w/a.md /w/d.md',
  "cat /w/a.md /w/b.md >> /w/b.md; cat /w/b.md",
  "grep -c hit /w/a.md /w/c.md > /w/c.md; cat /w/c.md",
];

async function run(bulk: boolean, chunkBytes: number) {
  const fs = createTestFileSystem({ chunkBytes });
  const files = Array.from({ length: 40 }, (_, i) => ({
    path: `/w/${String.fromCharCode(97 + (i % 26))}${i >= 26 ? i : ""}.md`,
    body: `title ${i}\n${i % 3 === 0 ? "see hit\n" : "plain line\n"}${"x".repeat(i)}\n`,
  }));
  await fs.writeFiles(files, { createParents: true });
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

it("gives operand commands the answers of per-file reads, including writes between files", async () => {
  for (const chunkBytes of [4096, 7]) {
    const bulk = await run(true, chunkBytes);
    expect(bulk).toEqual(await run(false, chunkBytes));
    expect(bulk[1]?.stderr).toContain("missing.md");
  }
});

it("reads many operands in fewer statements", async () => {
  const count = async (bulk: boolean) => {
    let statements = 0;
    const fs = createTestFileSystem({ onStatement: () => statements++ });
    await fs.writeFiles(
      Array.from({ length: 100 }, (_, i) => ({ path: `/w/p${i}.md`, body: `page ${i}\n` })),
      { createParents: true },
    );
    const shell = new Shell({
      fileSystem: bulk ? fs : withoutBulkReads(fs),
      commands: defaultShellCommands,
    });
    statements = 0;
    const result = await shell.executeText({ cwd: "/", script: "cat /w/*.md | wc -l" });
    expect(result.stdout.trim()).toBe("100");
    return statements;
  };
  expect((await count(true)) * 3).toBeLessThan(await count(false));
});

it("hands out a body read ahead only while nothing has changed since", async () => {
  const fs = createTestFileSystem();
  await fs.writeFiles(
    ["/a", "/b", "/c"].map((path) => ({ path, body: path })),
    { createParents: true },
  );
  const context = {
    fileSystem: fs,
    budget: { remainingBufferedBytes: () => 1 << 30, buffered: () => () => undefined },
  } as unknown as ShellCommandContext;
  const ahead = new ReadAhead(context);
  ahead.fill(["/a", "/b", "/c"]);
  const generation = fs.changeGeneration();
  fs.stat("/a");
  fs.statMany(["/a", "/b"]);
  fs.readMany(["/a", "/b"]);
  await new Response(fs.readFile("/c").stream).text();
  expect(fs.changeGeneration()).toBe(generation);
  expect(ahead.take("/a")?.chunks).toEqual([new TextEncoder().encode("/a")]);
  await fs.writeFile("/c", "changed");
  expect(fs.changeGeneration()).not.toBe(generation);
  expect(ahead.take("/b")).toBeUndefined();
  ahead.fill(["/b", "/c"]);
  expect(ahead.take("/c")?.chunks).toEqual([new TextEncoder().encode("changed")]);
  fs.setMetadata("/b", { mode: 0o600 });
  expect(ahead.take("/b")).toBeUndefined();
});

import { expect, it } from "vitest";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { Shell } from "../src/shell/shell.js";
import type { ShellDerivedLimits } from "../src/shell/types.js";
import { createTestFileSystem, withoutBulkReads } from "./helpers/node-sql.js";

// Commands that read every input before they start take file operands read
// ahead in bulk; each must print what reading every file as a stream prints.
const SCRIPTS = [
  "jq -r '.title' /d/*.json",
  "jq -c 'select(.size > 500) | {id, owner}' /d/*.json",
  "jq -s 'map(.size) | add' /d/*.json",
  "jq -r '.tags[]' /d/*.json | sort | uniq -c",
  "jq . /d/a.json /x/bad.json /d/b.json",
  "jq . /d/a.json /x/missing.json",
  "jq -R . /t/*.txt | head -3",
  "sort /t/*.txt | head -5",
  "sort -u /t/*.txt /t/a.txt | wc -l",
  "paste /t/a.txt /t/b.txt",
  "diff /t/a.txt /t/b.txt",
  "comm /t/a.txt /t/b.txt",
  "join /t/a.txt /t/b.txt",
  "tail -n 2 /t/*.txt",
  "sort /t/a.txt - /t/b.txt < /t/c.txt",
];

// Limits that trip at a file read in bulk, after standard input or earlier
// files: the error names that file as reading it alone does.
const LIMITED: [string, Partial<ShellDerivedLimits>][] = [
  ["sort /m/*", { maxReadBytes: 950 }],
  ["paste /m/*", { maxReadBytes: 1000 }],
  ["tail -n 1 /m/*", { maxReadBytes: 950 }],
  ["sort /m/f00 /m/f01 - /m/f02 /m/f03 < /t/big", { maxBufferedBytes: 4300 }],
  ["paste /m/f00 - /m/f01 /m/f02 < /t/big", { maxBufferedBytes: 4200 }],
];

async function run(bulk: boolean, chunkBytes: number) {
  let statements = 0;
  const fs = createTestFileSystem({ chunkBytes, onStatement: () => statements++ });
  const json = Array.from({ length: 40 }, (_, i) => ({
    path: `/d/${String.fromCharCode(97 + (i % 26))}${i >= 26 ? i : ""}.json`,
    body: `${JSON.stringify({ id: i, title: `항목 ${i} é`, owner: `o${i % 3}`, size: (i * 97) % 1000, tags: [`t${i % 5}`] }, null, 2)}\n`,
  }));
  const text = ["a", "b", "c"].map((name, i) => ({
    path: `/t/${name}.txt`,
    body:
      Array.from({ length: 12 }, (_, line) => `${name}${(line * (i + 3)) % 17} ü`).join("\n") +
      "\n",
  }));
  const limited = Array.from({ length: 20 }, (_, i) => ({
    path: `/m/f${String(i).padStart(2, "0")}`,
    body: `${"x".repeat(98)}${i % 10}\n`,
  }));
  await fs.writeFiles([...json, ...text, ...limited, { path: "/t/big", body: "y".repeat(4000) }], {
    createParents: true,
  });
  await fs.mkdir("/x");
  await fs.writeFile("/x/bad.json", "{ not json\n");
  const shell = (limits: Partial<ShellDerivedLimits> = {}) =>
    new Shell({
      fileSystem: bulk ? fs : withoutBulkReads(fs),
      commands: defaultShellCommands,
      limits,
    });
  const results = new Map<string, Awaited<ReturnType<Shell["executeText"]>>>();
  const counts = new Map<string, number>();
  for (const [script, limits] of [...SCRIPTS.map((s) => [s, {}] as const), ...LIMITED]) {
    statements = 0;
    results.set(
      script,
      await shell(limits).executeText({ cwd: "/", script: `${script}; echo "status $?"` }),
    );
    counts.set(script, statements);
  }
  return { results, counts };
}

it("prints from bulk-read operands what reading each file as a stream prints", async () => {
  for (const chunkBytes of [4096, 7]) {
    const bulk = await run(true, chunkBytes);
    const single = await run(false, chunkBytes);
    expect(bulk.results).toEqual(single.results);
    expect(bulk.results.get("jq -r '.title' /d/*.json")?.stdout).toContain("항목 0 é");
    expect(bulk.results.get("sort /m/*")?.stderr).toContain("/m/f09:");
    expect(bulk.results.get("sort /m/f00 /m/f01 - /m/f02 /m/f03 < /t/big")?.stderr).toContain(
      "/m/f03:",
    );
    if (chunkBytes === 4096) {
      // One read-ahead for the 40 files, where reading each alone takes a statement apiece.
      const key = "jq -r '.title' /d/*.json";
      expect(bulk.counts.get(key)).toBeLessThan(10);
      expect(single.counts.get(key)).toBeGreaterThanOrEqual(40);
    }
  }
});

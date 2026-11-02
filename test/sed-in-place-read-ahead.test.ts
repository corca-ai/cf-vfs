import { expect, it } from "vitest";
import { createFsAdapter } from "../src/fs/index.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { Shell } from "../src/shell/shell.js";
import type { ShellLimits } from "../src/shell/types.js";
import type { NodeSqlFileSystemOptions } from "../src/testing/node.js";
import { createTestFileSystem, withoutBulkReads } from "./helpers/node-sql.js";

type Layout = "plain" | "symlink" | "hardlink";

const FILES = Array.from({ length: 150 }, (_, i) => ({
  path: `/w/p${String(i).padStart(3, "0")}.md`,
  body: `title ${i}\nx owner: team${i % 4}\n${"body ".repeat(i % 2 === 0 ? 10 : 3000)}\n`,
}));

/** Every file's final contents, so a stale read or a lost write shows. */
const DIGEST =
  'for f in /w/*; do echo "== $f"; cat "$f"; done | md5sum; cat /w/p00[0-4].md /w/l*.md 2>&1 | head -c 400';

async function run(
  bulk: boolean,
  script: string,
  layout: Layout,
  limits: Partial<ShellLimits> = {},
  options: NodeSqlFileSystemOptions = {},
) {
  // Chunk queries by entry: one per file read alone, and writes issue the same one.
  let statements = 0;
  const fs = createTestFileSystem({
    chunkBytes: 4096,
    onStatement: (query: string) => {
      if (/^\s*SELECT body FROM vfs_inline_chunks\s+WHERE entry_id = \?/u.test(query)) statements++;
    },
    ...options,
  });
  fs.setMetadata("/", { mode: 0o777 });
  await fs.writeFiles(FILES, { createParents: true });
  fs.setOwnership("/w", { uid: 1000, gid: 1000 });
  for (const file of FILES) fs.setOwnership(file.path, { uid: 1000, gid: 1000 });
  fs.setMetadata("/w/p007.md", { mode: 0o444 });
  if (layout === "symlink") fs.symlink("/w/l1.md", "/w/p003.md");
  if (layout === "hardlink") await createFsAdapter(fs).promises.link("/w/p003.md", "/w/l1.md");
  const shell = new Shell({
    fileSystem: bulk ? fs : withoutBulkReads(fs),
    commands: defaultShellCommands,
    limits,
  });
  statements = 0;
  const result = await shell.executeText({
    cwd: "/w",
    credentials: { uid: 1000, gid: 1000 },
    script: `${script}; echo "status $?"; ${DIGEST}`,
  });
  return { result, statements };
}

const CASES: [string, Layout, Partial<ShellLimits>?, NodeSqlFileSystemOptions?][] = [
  ["sed -i 's/x/xx/' p*.md", "plain"],
  ["sed -i 's/x/xx/' l1.md p003.md p004.md p003.md", "symlink"],
  ["sed -i 's/x/xx/' p003.md l1.md p004.md l1.md", "hardlink"],
  ["sed -i 's/x/xx/' l1.md p00*.md", "hardlink"],
  ["sed -i '1q; s/x/xx/' p007.md p008.md p009.md", "plain"],
  ["sed -i 's/x/xx/' p001.md missing.md p002.md", "plain"],
  ["sed -i 's/x/xx/' p*.md", "plain", { maxMutations: 70 }],
  ["sed -i 's/x/xx/' p*.md", "plain", { maxBufferedBytes: 40_000 }],
  // The seeded wiki is about 1,141 KB; doubling the long bodies outgrows the quota partway.
  ["sed -i 's/body/body body/' p00*.md", "plain", {}, { maxInlineLogicalBytes: 1_180_000 }],
];

it("gives sed -i over read-ahead operands exactly the outcomes of reading one file at a time", async () => {
  for (const [script, layout, limits, options] of CASES) {
    const bulk = await run(true, script, layout, limits, options);
    const single = await run(false, script, layout, limits, options);
    expect(bulk.result, `${layout}: ${script}`).toEqual(single.result);
  }
});

it("hands a concurrent stage a serializable view of sed -i's rewrites", async () => {
  // Stages interleave by scheduling, so only what any order allows is checked:
  // every file sed rewrote shows its edit afterwards, and none is half-written.
  const { result } = await run(
    true,
    "{ echo new > p002.md; cat p009.md > /dev/null; } | sed -i 's/x/xx/' p00*.md",
    "plain",
  );
  expect(result.stdout).toMatch(/status [02]/u);
  expect(result.stdout).not.toMatch(/^x owner/mu);
});

it("keeps the read-ahead across sed's own writes", async () => {
  const bulk = await run(true, "sed -i 's/x/xx/' p*.md", "plain");
  const single = await run(false, "sed -i 's/x/xx/' p*.md", "plain");
  expect(bulk.result.stdout).toContain("status 2");
  expect(bulk.result.stderr).toContain("p007.md");
  // Nearly all 150 files are read ahead rather than one query each.
  expect(single.statements - bulk.statements).toBeGreaterThan(140);
});

import { expect, it } from "vitest";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { Shell } from "../src/shell/shell.js";
import { createTestFileSystem, withoutBulkReads } from "./helpers/node-sql.js";

// grep splits bulk-read bodies synchronously and reuses the text it decoded
// to rule a body out; every mode must print what reading each file as a
// stream prints.
const SCRIPTS = [
  "grep hit /w/*.md",
  "grep -n hit /w/*.md",
  "grep -c hit /w/*.md",
  "grep -l hit /w/*.md",
  "grep -L hit /w/*.md",
  "grep -q hit /w/*.md",
  "grep -v hit /w/*.md",
  "grep -o 'hit [0-9]*' /w/*.md",
  "grep -on 'hit [0-9]*' /w/*.md",
  "grep -ov hit /w/*.md; echo $?",
  "grep -oc hit /w/*.md",
  "grep -o -A 1 hit /w/a.md",
  "grep -om 1 hit /w/*.md",
  "grep -o . /x/long.md | wc -c",
  "grep -oH . /x/long.md | tail -2",
  "grep -o x /x/huge-line.md | wc -l",
  "grep -m 1 hit /w/*.md",
  "grep -m 2 -A 1 hit /w/*.md",
  "grep -B 2 -n hit /w/*.md",
  "grep -C 1 hit /w/*.md",
  "grep -A 1 -m 1 -c hit /w/*.md",
  "grep -h -e hit -e plain /w/*.md",
  "grep -E 'hit|^title' /w/*.md",
  "grep -i HIT /w/*.md",
  "grep -x 'see hit 3' /w/*.md",
  "grep -rn hit /w",
  "grep -rc hit /w | sort",
  "grep -rl hit /w",
  "grep hit /w/a.md /x/bad.md /w/d.md",
  "grep -c '' /x/bom.md /x/long.md",
  "grep -c hit /x/long.md; grep -o hit /x/long.md | wc -l",
  "grep -n x /x/huge-line.md",
  "grep hit /w/a.md | head -1",
];

async function run(bulk: boolean, chunkBytes: number) {
  const fs = createTestFileSystem({ chunkBytes });
  const files = Array.from({ length: 30 }, (_, i) => ({
    path: `/w/${String.fromCharCode(97 + (i % 26))}${i >= 26 ? i : ""}.md`,
    body: `title ${i}\n${i % 3 === 0 ? `see hit ${i}\nplain\nsee hit again ${i}\n` : "plain line\n"}${"x".repeat(i)}`,
  }));
  await fs.writeFiles(files, { createParents: true });
  await fs.mkdir("/x");
  await fs.writeFile("/x/bad.md", Uint8Array.of(0x68, 0x69, 0x74, 0x0a, 0xff, 0x0a));
  await fs.writeFile("/x/bom.md", "\uFEFFhit first\nplain\n");
  await fs.writeFile("/x/long.md", `${"hit ".repeat(2000)}\nplain\nhit\n`);
  await fs.writeFile("/x/huge-line.md", `${"x".repeat(9000)}\nx\n`);
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

it("prints from bulk-read bodies what reading each file as a stream prints", async () => {
  for (const chunkBytes of [4096, 7]) {
    const bulk = await run(true, chunkBytes);
    expect(bulk).toEqual(await run(false, chunkBytes));
    expect(bulk[0]?.stdout).toContain("see hit 0");
    expect(bulk.some((result) => result.stderr.includes("not valid UTF-8"))).toBe(true);
  }
});

it("prints each match of -o in order, past the writer's 64 KiB buffer", async () => {
  const fs = createTestFileSystem({});
  await fs.writeFile("/many", `${"ab ".repeat(40_000)}\nnone\nAB\n`);
  await fs.writeFile("/second", "ab\n");
  const shell = new Shell({ fileSystem: fs, commands: defaultShellCommands });
  const output = async (script: string) => (await shell.executeText({ cwd: "/", script })).stdout;

  expect(await output("grep -on ab many")).toBe("1:ab\n".repeat(40_000));
  expect(await output("grep -oH ab many second | tail -2")).toBe("many:ab\nsecond:ab\n");
  expect(await output("grep -oiF ab many | tail -1")).toBe("AB\n");
  expect(await output("grep -o -e ab -e a second")).toBe("ab\n");
  expect(await output("grep -ov ab second; echo $?")).toBe("1\n");
  expect(await output("grep -ovx ab second many | wc -c")).toBe("0\n");
  expect(await output("grep -om 1 ab second many | wc -l")).toBe("40001\n");
});

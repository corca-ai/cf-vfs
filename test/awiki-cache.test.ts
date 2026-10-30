import { describe, expect, it } from "vitest";
import { awikiCommand } from "../src/shell/commands/awiki.js";
import { createBashHarness } from "./helpers/bash.js";

// The parsed-page cache must be invisible: edits show up at once, and a warm
// run charges the same reads as a cold one, so limits never depend on it.

const WIKI = {
  "/w/A.md": "Alpha links [[B]].\n",
  "/w/B.md": "Beta links [[A]].\n",
  "/w/C.md": "Gamma stands alone.\n",
};
const WIKI_BYTES = Object.values(WIKI).reduce(
  (sum, text) => sum + new TextEncoder().encode(text).length,
  0,
);

async function harnessWith(files: Readonly<Record<string, string>>, maxReadBytes?: number) {
  const harness = createBashHarness({
    extraCommands: [awikiCommand],
    ...(maxReadBytes === undefined ? {} : { limits: { maxReadBytes } }),
  });
  for (const [path, content] of Object.entries(files)) {
    await harness.fileSystem.writeFile(path, content, { createParents: true });
  }
  return harness;
}

describe("awiki page cache", () => {
  it("sees edits, removals and new pages between runs", async () => {
    const harness = await harnessWith(WIKI);
    expect((await harness.run("awiki links -root /w A")).stdout).toBe(
      "// this page\n[[A]]: Alpha links [[B]].\n// incoming links\n[[B]]: Beta links [[A]].\n// outgoing links\n[[B]]: Beta links [[A]].\n",
    );
    await harness.run(
      "echo 'Now also [[C]] and [[D]].' >> /w/A.md; rm /w/B.md; echo 'Delta.' > /w/D.md",
    );
    const after = await harness.run("awiki links -root /w A");
    expect(after.stdout).toBe(
      "// this page\n[[A]]: Alpha links [[B]].\n// incoming links\n// none\n// outgoing links\n[[C]]: Gamma stands alone.\n[[D]]: Delta.\n[[B]]: (missing)\n",
    );
  });

  it("charges a warm run the reads of a cold one", async () => {
    const harness = await harnessWith(WIKI, WIKI_BYTES);
    // Cold, then warm: each execution reads every page once, exactly at the limit.
    for (let run = 0; run < 2; run += 1) {
      const result = await harness.run("awiki lint -root /w");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(1);
    }
    const twice = await harness.run("awiki lint -root /w >/dev/null; awiki lint -root /w");
    expect(twice.exitCode).toBe(1);
    expect(twice.stderr).toContain("shell file read byte limit exceeded");
  });

  it("charges format's reread on a page already known to be formatted", async () => {
    const harness = await harnessWith(WIKI, WIKI_BYTES * 2);
    const first = await harness.run("awiki format -root /w");
    expect(first.stdout).toBe("// format documents=3 changed=0\n");
    const second = await harness.run("awiki format -root /w");
    expect(second.stdout).toBe(first.stdout);
    const third = await harness.run("awiki format -root /w; awiki lint -root /w");
    expect(third.stderr).toContain("shell file read byte limit exceeded");
  });

  it("rereads only the pages that name a renamed document", async () => {
    const files: Record<string, string> = { "/w/Target.md": "The target.\n" };
    for (let index = 0; index < 40; index += 1) {
      files[`/w/p${index}.md`] =
        index < 3 ? `Links [[Target]] from ${index}.\n` : `Unrelated ${index}.\n`;
    }
    const total = Object.values(files).reduce((sum, text) => sum + text.length, 0);
    // Loading reads every page once; the rewrite rereads the target and three linkers.
    const rereads = "The target.\n".length + 3 * "Links [[Target]] from 0.\n".length + 2;
    const harness = await harnessWith(files, total + rereads);
    const result = await harness.run("awiki rename -root /w Target Goal");
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      "// rename old=Target.md new=Goal.md\n// links_updated=3 files_touched=3 title_updated=false\n",
    );
    expect(await harness.readText("/w/p1.md")).toBe("Links [[Goal]] from 1.\n");
  });
});

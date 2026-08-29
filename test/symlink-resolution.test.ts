import { expect, it } from "vitest";
import { createBashHarness } from "./helpers/bash.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

async function readAll(
  fs: { readFile: (path: string) => { stream: ReadableStream<Uint8Array> } },
  path: string,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = fs.readFile(path).stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  return new TextDecoder().decode(
    chunks.reduce<Uint8Array>((all, chunk) => {
      const merged = new Uint8Array(all.length + chunk.length);
      merged.set(all);
      merged.set(chunk, all.length);
      return merged;
    }, new Uint8Array()),
  );
}
it("does not reinterpret an inferred link name as a destination directory", async () => {
  const harness = createBashHarness();
  harness.fileSystem.mkdir("/foo");

  const result = await harness.run("ln -s /missing/foo");

  expect(result.exitCode).toBe(1);
  expect(harness.fileSystem.list("/foo")).toEqual([]);
});

it("infers a link name from a target with trailing slashes", async () => {
  const harness = createBashHarness();

  const result = await harness.run("ln -s /missing/bar/");

  expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  expect(harness.fileSystem.lstat("/bar")).toMatchObject({
    kind: "symlink",
    linkTarget: "/missing/bar/",
  });
});

it("does not follow a directory symlink when measuring disk usage", async () => {
  const harness = createBashHarness();
  await harness.fileSystem.writeFile("/directory/file", "x".repeat(1024), {
    createParents: true,
  });
  harness.fileSystem.symlink("/link", "/directory");

  expect(await harness.run("du /link")).toMatchObject({
    exitCode: 0,
    stdout: "0\t/link\n",
    stderr: "",
  });
});

it("resolves absolute, relative, nested, and directory links", async () => {
  const fs = createTestFileSystem();
  await fs.writeFile("/t/real.txt", "body\n", { createParents: true });
  await fs.mkdir("/t/sub", true);
  await fs.writeFile("/t/sub/deep.txt", "deep\n");

  fs.symlink("/t/rel", "real.txt");
  fs.symlink("/t/abs", "/t/real.txt");
  fs.symlink("/dirlink", "/t/sub");
  fs.symlink("/hop", "/t/rel");

  // A relative target reads from the link's own parent, not the caller's cwd.
  expect(fs.stat("/t/rel").path).toBe("/t/real.txt");
  expect(fs.stat("/t/abs").path).toBe("/t/real.txt");
  // A link in the middle of a path is followed.
  expect(fs.stat("/dirlink/deep.txt").path).toBe("/t/sub/deep.txt");
  // A link to a link is followed to the end.
  expect(fs.stat("/hop").path).toBe("/t/real.txt");
  expect(fs.realpath("/hop")).toBe("/t/real.txt");
  // `lstat` stops at the link, and reports the target verbatim.
  expect(fs.lstat("/t/rel")).toMatchObject({ kind: "symlink", linkTarget: "real.txt" });
  expect(fs.readlink("/t/rel")).toBe("real.txt");
});

it("keeps a link from becoming the parent of an entry", async () => {
  const fs = createTestFileSystem();
  await fs.mkdir("/target", true);
  fs.symlink("/dirlink", "/target");
  await fs.writeFile("/dirlink/made.txt", "x\n");
  // The entry lands at its canonical path, so an exact lookup can be trusted.
  expect(fs.lstat("/target/made.txt").kind).toBe("file");
  // Nothing is stored under the link's own path, so an exact-path hit can
  // be trusted without walking components.
  expect(fs.find({ path: "/target", includeRoot: true }).map((entry) => entry.path)).toEqual([
    "/target",
    "/target/made.txt",
  ]);
  expect(fs.realpath("/dirlink/made.txt")).toBe("/target/made.txt");
  // A link to a file is not a directory to create under.
  fs.symlink("/filelink", "/target/made.txt");
  await expect(
    fs.writeFile("/filelink/nope.txt", "x\n", { createParents: true }),
  ).rejects.toThrowError(/ENOTDIR|not a directory/u);
});

it("refuses a cycle and excessive indirection with a bounded hop count", async () => {
  const fs = createTestFileSystem();
  fs.symlink("/a", "/b");
  fs.symlink("/b", "/a");
  expect(() => fs.stat("/a")).toThrowError(/too many levels of symbolic links/u);
  // A chain longer than the bound is refused the same way, so the limit does
  // not depend on the cycle being a cycle.
  for (let index = 0; index < 60; index += 1) fs.symlink(`/c${index}`, `/c${index + 1}`);
  expect(() => fs.stat("/c0")).toThrowError(/too many levels of symbolic links/u);
  // A chain inside the bound still resolves.
  await fs.writeFile("/end.txt", "x\n");
  fs.symlink("/d0", "/end.txt");
  for (let index = 1; index < 20; index += 1) fs.symlink(`/d${index}`, `/d${index - 1}`);
  expect(fs.stat("/d19").path).toBe("/end.txt");
});

it("treats a dangling link as present but unresolvable", async () => {
  const fs = createTestFileSystem();
  fs.symlink("/dangling", "/nowhere");
  expect(fs.lstat("/dangling").kind).toBe("symlink");
  expect(() => fs.stat("/dangling")).toThrowError(/no such file or directory/u);
  // Creating one is allowed, so the order a tree is restored in does not
  // matter; writing through it creates the target.
  await fs.writeFile("/dangling", "made\n");
  expect(fs.stat("/nowhere").sizeBytes).toBe(5);
  expect(fs.lstat("/dangling").kind).toBe("symlink");
});

it("separates the link's revision and mutation token from its target's", async () => {
  const fs = createTestFileSystem();
  await fs.writeFile("/target.txt", "one\n");
  // Twice, so the link and the target sit at different path versions and no
  // assertion below can pass by coincidence.
  await fs.writeFile("/target.txt", "one\n", { disposition: "replace" });
  fs.symlink("/link.txt", "/target.txt");
  const link = (): string => fs.getMutationToken("/link.txt", { follow: false });
  const linkToken = link();

  // The default follows, so a token read through the link covers the target
  // — it has to, or it would never match the write it is meant to guard —
  // and also the link, so repointing the link invalidates it.
  const through = fs.getMutationToken("/link.txt");
  expect(through).toContain(fs.getMutationToken("/target.txt"));
  expect(through).toContain(linkToken);
  expect(linkToken).not.toBe(fs.getMutationToken("/target.txt"));

  await fs.writeFile("/target.txt", "two\n", { disposition: "replace" });
  // Writing the target does not disturb the link: the link did not change.
  expect(link()).toBe(linkToken);
  const targetToken = fs.getMutationToken("/target.txt");

  fs.symlink("/link.txt", "/elsewhere", { replace: true, ifMutationToken: linkToken });
  expect(fs.readlink("/link.txt")).toBe("/elsewhere");
  // Replacing the link bumps the link's token and leaves the target's alone.
  expect(link()).not.toBe(linkToken);
  expect(fs.getMutationToken("/target.txt")).toBe(targetToken);
  expect(fs.stat("/target.txt").sizeBytes).toBe(4);

  // The token that was current a moment ago is refused, so a caller that
  // read the link, decided, and came back cannot overwrite a newer decision.
  expect(() =>
    fs.symlink("/link.txt", "/third", { replace: true, ifMutationToken: linkToken }),
  ).toThrowError(/mutation token/u);
  expect(fs.readlink("/link.txt")).toBe("/elsewhere");
});

it("guards a write through a link with the target's token", async () => {
  const fs = createTestFileSystem();
  await fs.writeFile("/target.txt", "one\n");
  // Two writes, so the link and the target are at different path versions
  // and a guard read from the wrong one cannot match by coincidence.
  await fs.writeFile("/target.txt", "two\n", { disposition: "replace" });
  fs.symlink("/link.txt", "/target.txt");
  const token = fs.getMutationToken("/link.txt");
  await fs.writeFile("/link.txt", "three\n", {
    disposition: "replace",
    ifMutationToken: token,
  });
  expect(await readAll(fs, "/target.txt")).toBe("three\n");
  expect(fs.lstat("/link.txt").kind).toBe("symlink");
});

it("refuses a guarded write when the link was repointed underneath it", async () => {
  const fs = createTestFileSystem();
  await fs.writeFile("/a.txt", "AAA\n");
  await fs.writeFile("/b.txt", "BBB\n");
  fs.symlink("/link", "/a.txt");
  const token = fs.getMutationToken("/link");

  // Both targets sit at the same path version, so a token that named only
  // where the link currently points would match after it was repointed —
  // the path the caller reserved now means a different file.
  fs.symlink("/link", "/b.txt", { replace: true });
  await expect(
    fs.writeFile("/link", "CALLER\n", { disposition: "replace", ifMutationToken: token }),
  ).rejects.toThrowError(/mutation token/u);
  expect(await readAll(fs, "/a.txt")).toBe("AAA\n");
  expect(await readAll(fs, "/b.txt")).toBe("BBB\n");

  // A token taken after the change is accepted, and writes through the link.
  await fs.writeFile("/link", "CALLER\n", {
    disposition: "replace",
    ifMutationToken: fs.getMutationToken("/link"),
  });
  expect(await readAll(fs, "/b.txt")).toBe("CALLER\n");
});

it("costs a namespace without links exactly what it cost before", async () => {
  const queries: string[] = [];
  const fs = createTestFileSystem({ onStatement: (query) => queries.push(query) });
  await fs.writeFile("/a/b/c.txt", "x\n", { createParents: true });
  await fs.mkdir("/seed", true);

  const count = (run: () => unknown): number => {
    queries.length = 0;
    run();
    return queries.length;
  };
  const baseline = {
    stat: count(() => fs.stat("/a/b/c.txt")),
    read: count(() => fs.readFile("/a/b/c.txt").stream.cancel()),
    token: count(() => fs.getMutationToken("/a/b/c.txt")),
  };
  // Pinned absolutely, not merely capped: a bound with no floor is satisfied
  // by a meter that stopped counting. These are the counts the filesystem
  // had before links existed, measured on the previous release.
  expect(baseline).toEqual({ stat: 1, read: 2, token: 3 });

  // One link somewhere else must not change what reading an unrelated path
  // costs, because both operations keep the row resolution landed on.
  fs.symlink("/unrelated", "/a");
  expect(count(() => fs.stat("/a/b/c.txt"))).toBe(baseline.stat);
  expect(count(() => fs.readFile("/a/b/c.txt").stream.cancel())).toBe(baseline.read);
  // A token costs one more: it needs the canonical path, and unlike the two
  // above it has no use for the row that resolving it produced.
  expect(count(() => fs.getMutationToken("/a/b/c.txt"))).toBe(baseline.token + 1);

  // Resolving through a link costs one lookup per hop — not one per
  // component, and nothing that grows with the size of the namespace.
  expect(count(() => fs.stat("/unrelated/b/c.txt"))).toBe(baseline.stat + 2);
  for (let index = 0; index < 200; index += 1) {
    await fs.writeFile(`/a/bulk${index}.txt`, "x\n");
  }
  expect(count(() => fs.stat("/unrelated/b/c.txt"))).toBe(baseline.stat + 2);
});

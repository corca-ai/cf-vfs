import { expect, it, vi } from "vitest";
import { applyTextEdits, CollaborativeFileSystem, DocumentRegistry } from "../src/collab/index.js";
import { gitCommand } from "../src/shell/commands/git.js";
import { Shell } from "../src/shell/shell.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

async function fixture(body = "base\n") {
  const raw = createTestFileSystem({ now: () => 1000 });
  const registry = new DocumentRegistry();
  const view = new CollaborativeFileSystem(raw, registry);
  const shell = new Shell({ fileSystem: view, commands: [gitCommand] });
  const run = (script: string) => shell.executeText({ script, cwd: "/repo" });
  const ok = async (script: string) => {
    const result = await run(script);
    expect(result.exitCode, result.stderr).toBe(0);
    return result.stdout;
  };
  await shell.executeText({ script: "git init /repo" });
  await ok("git config user.name Test; git config user.email test@example.invalid");
  await raw.writeFile("/repo/f", body);
  await ok("git add -A; git commit -m base");
  await ok("git status --porcelain");
  await ok("git status --porcelain");
  return { raw, registry, view, shell, run, ok };
}

it("reuses a body hash while detecting same-size edits, mode changes and recreated paths", async () => {
  const { raw, ok } = await fixture();
  const reads = vi.spyOn(raw, "readFile");
  expect(await ok("git status --porcelain")).toBe("");
  expect(
    reads.mock.calls.some(([path, options]) => path === "/repo/f" && options?.range === undefined),
  ).toBe(false);
  await raw.writeFile("/repo/f", "next\n");
  expect(await ok("git status --porcelain")).toContain(' M "f"');
  await raw.writeFile("/repo/f", "base\n");
  raw.setMetadata("/repo/f", { mode: 0o100755 });
  expect(await ok("git status --porcelain")).toContain(' M "f"');
  await raw.remove("/repo/f");
  await raw.writeFile("/repo/f", "else\n");
  expect(await ok("git status --porcelain")).toContain(' M "f"');
});

it("does not reuse a regular-file identity after replacement by a dangling symlink", async () => {
  const { raw, ok } = await fixture();
  await raw.remove("/repo/f");
  raw.symlink("/repo/f", "missing-target");
  expect(await ok("git status --porcelain")).toContain(' M "f"');
  await raw.remove("/repo/f");
  await raw.writeFile("/repo/f", "base\n");
  expect(await ok("git status --porcelain")).toBe("");
});

it("checks read permission even for hashes warmed by another credential view", async () => {
  const { raw, view } = await fixture();
  raw.setMetadata("/repo/f", { mode: 0o100000 });
  const root = new Shell({ fileSystem: view, commands: [gitCommand] });
  expect(
    (await root.executeText({ script: "git status --porcelain", cwd: "/repo" })).exitCode,
  ).toBe(0);
  const restricted = new Shell({
    fileSystem: view,
    commands: [gitCommand],
  });
  const result = await restricted.executeText({
    script: "git status --porcelain",
    cwd: "/repo",
    credentials: { uid: 1000, gid: 1000 },
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toMatch(/permission|EACCES/iu);
});

it("keeps CRLF conversion settings in the content identity", async () => {
  const { ok } = await fixture("line\r\n");
  expect(await ok("git status --porcelain")).toBe("");
  await ok("git config core.autocrlf true");
  expect(await ok("git status --porcelain")).toContain(' M "f"');
  await ok("git add -A; git commit -m normalize");
  expect(await ok("git status --porcelain")).toBe("");
  await ok("git config core.autocrlf false");
  expect(await ok("git status --porcelain")).toContain(' M "f"');
});

it("detects unpublished document edits while leaving stored bytes untouched", async () => {
  const { raw, registry, ok } = await fixture();
  let text = "base\n";
  const doc = {
    text: () => text,
    applyExternal: (edits: Parameters<typeof applyTextEdits>[1]) => {
      text = applyTextEdits(text, edits);
    },
  };
  registry.open("/repo/f", doc, raw.stat("/repo/f").mutationToken);
  text = "next\n";
  registry.markDirty("/repo/f");
  expect(await ok("git status --porcelain")).toContain(' M "f"');
  expect(await ok("git status --porcelain")).toContain(' M "f"');
  expect(await new Response(raw.readFile("/repo/f").stream).text()).toBe("base\n");
});

it("isolates identical opaque tokens in independent filesystems", async () => {
  const first = await fixture("first\n");
  const second = await fixture("other\n");
  for (const { raw, ok } of [first, second]) {
    const lstat = raw.lstat.bind(raw);
    vi.spyOn(raw, "lstat").mockImplementation((...args) => ({
      ...lstat(...args),
      mutationToken: "same-opaque-token",
    }));
    const read = raw.readFile.bind(raw);
    vi.spyOn(raw, "readFile").mockImplementation((...args) => {
      const result = read(...args);
      return { ...result, stat: { ...result.stat, mutationToken: "same-opaque-token" } };
    });
    expect(await ok("git status --porcelain")).toBe("");
    expect(await ok("git status --porcelain")).toBe("");
  }
  expect(await first.ok("git status --porcelain")).toBe("");
});

it.each(["maxTotalIoBytes", "maxBufferedBytes"] as const)(
  "preserves %s on warm cached bodies",
  async (limit) => {
    const { raw, view } = await fixture("x".repeat(128 * 1024));
    const token = raw.getMutationToken("/repo/.git/index");
    const events: string[] = [];
    const shell = new Shell({
      fileSystem: view,
      commands: [gitCommand],
      limits: { [limit]: 16 * 1024 },
      onEvent: (event) => {
        if (event.type === "shell.limit") events.push(event.limit);
      },
    });
    expect(
      (await shell.executeText({ script: "git status --porcelain", cwd: "/repo" })).exitCode,
    ).not.toBe(0);
    expect(events).toContain(limit);
    expect(raw.getMutationToken("/repo/.git/index")).toBe(token);
  },
);

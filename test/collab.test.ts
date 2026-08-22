import { describe, expect, it } from "vitest";
import {
  applyTextEdits,
  type CollaborativeDocument,
  CollaborativeFileSystem,
  DocumentRegistry,
  publishDocument,
  reconcileDocument,
  type TextEdit,
  textEdits,
} from "../src/collab/index.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { Shell } from "../src/shell/shell.js";
import type { VfsEvent } from "../src/vfs/events.js";
import { readAllBytes } from "../src/vfs/streams.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

/**
 * A document that keeps plain text and records what arrived from outside.
 *
 * A real host plugs a CRDT in here; what the module owns is that external
 * changes arrive as edits at all, which this is enough to pin.
 */
class TextDocument implements CollaborativeDocument {
  #text: string;
  readonly external: TextEdit[][] = [];

  constructor(text: string) {
    this.#text = text;
  }

  text(): string {
    return this.#text;
  }

  applyExternal(edits: readonly TextEdit[]): void {
    this.external.push([...edits]);
    this.#text = applyTextEdits(this.#text, edits);
  }

  /** A local edit, as an editing session would make. */
  type(offset: number, insert: string): void {
    this.#text = applyTextEdits(this.#text, [{ offset, remove: 0, insert }]);
  }
}

async function read(
  fileSystem: { readFile(path: string): { stream: ReadableStream<Uint8Array> } },
  path: string,
) {
  return new TextDecoder().decode(await readAllBytes(fileSystem.readFile(path).stream, 1 << 20));
}

describe("text edits", () => {
  it("derives a minimal replacement for a changed line", () => {
    const before = "alpha\nbeta\ngamma\n";
    const edits = textEdits(before, "alpha\nBETA\ngamma\n");
    expect(edits).toEqual([{ offset: 6, remove: 5, insert: "BETA\n" }]);
    expect(applyTextEdits(before, edits)).toBe("alpha\nBETA\ngamma\n");
  });

  it("reports nothing for identical text", () => {
    expect(textEdits("same\n", "same\n")).toEqual([]);
  });

  it("round-trips insertions, deletions, and rewrites", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["", "new\n"],
      ["gone\n", ""],
      ["a\nb\nc\n", "a\nc\n"],
      ["a\nc\n", "a\nb\nc\n"],
      ["one\ntwo\n", "TWO\nthree\n"],
      ["no trailing newline", "no trailing newline!"],
    ];
    for (const [before, after] of cases) {
      expect(applyTextEdits(before, textEdits(before, after))).toBe(after);
    }
  });
});

describe("document registry", () => {
  it("follows an open document through a move", () => {
    const registry = new DocumentRegistry();
    registry.open("/src/a.ts", new TextDocument("x"), "token");
    registry.open("/src/deep/b.ts", new TextDocument("y"), "token");
    registry.open("/elsewhere.ts", new TextDocument("z"), "token");

    const moved: VfsEvent = {
      type: "vfs.mutation",
      op: "move",
      path: "/src",
      subtree: { root: "/src", to: "/lib" },
    };
    registry.observe(moved);

    expect(registry.paths().sort()).toEqual(["/elsewhere.ts", "/lib/a.ts", "/lib/deep/b.ts"]);
    expect(registry.get("/lib/a.ts")?.document.text()).toBe("x");
  });

  it("closes what a removal took, and leaves the rest", () => {
    const registry = new DocumentRegistry();
    registry.open("/src/a.ts", new TextDocument("x"), "token");
    registry.open("/other.ts", new TextDocument("y"), "token");
    registry.observe({
      type: "vfs.mutation",
      op: "remove",
      path: "/src",
      subtree: { root: "/src" },
    });
    expect(registry.paths()).toEqual(["/other.ts"]);
  });

  it("publishes under the token it was opened at and skips an unchanged flush", async () => {
    const fileSystem = createTestFileSystem();
    await fileSystem.writeFile("/doc.txt", "body\n");
    const registry = new DocumentRegistry();
    const document = new TextDocument("body\n");
    registry.open("/doc.txt", document, fileSystem.stat("/doc.txt").mutationToken);

    expect(await publishDocument(fileSystem, registry, "/doc.txt")).toBe(false);

    document.type(5, "more\n");
    registry.markDirty("/doc.txt");
    const revisionBefore = fileSystem.stat("/doc.txt").revision;
    expect(await publishDocument(fileSystem, registry, "/doc.txt")).toBe(true);
    expect(await read(fileSystem, "/doc.txt")).toBe("body\nmore\n");
    expect(fileSystem.stat("/doc.txt").revision).toBe(revisionBefore + 1);

    // A flush with nothing new publishes nothing, and one whose text happens
    // to match what is stored does not churn the revision either.
    expect(await publishDocument(fileSystem, registry, "/doc.txt")).toBe(false);
    registry.markDirty("/doc.txt");
    const settled = fileSystem.stat("/doc.txt").revision;
    await publishDocument(fileSystem, registry, "/doc.txt");
    expect(fileSystem.stat("/doc.txt").revision).toBe(settled);
  });

  it("refuses to publish over a change it did not see", async () => {
    const fileSystem = createTestFileSystem();
    await fileSystem.writeFile("/doc.txt", "body\n");
    const registry = new DocumentRegistry();
    const document = new TextDocument("body\n");
    registry.open("/doc.txt", document, fileSystem.stat("/doc.txt").mutationToken);

    await fileSystem.writeFile("/doc.txt", "someone else\n");
    document.type(0, "mine ");
    registry.markDirty("/doc.txt");

    await expect(publishDocument(fileSystem, registry, "/doc.txt")).rejects.toMatchObject({
      code: "EREVISION",
    });

    // Reconciling is what a caller does with that, and the local edit survives.
    expect(await reconcileDocument(fileSystem, registry, "/doc.txt")).toBe(true);
    registry.markDirty("/doc.txt");
    expect(await publishDocument(fileSystem, registry, "/doc.txt")).toBe(true);
    expect(await read(fileSystem, "/doc.txt")).toBe("someone else\n");
    expect(document.external).toHaveLength(1);
  });
});

describe("collaborative filesystem", () => {
  function open(text: string) {
    const inner = createTestFileSystem();
    const registry = new DocumentRegistry();
    const document = new TextDocument(text);
    const fileSystem = new CollaborativeFileSystem(inner, registry);
    return { inner, registry, document, fileSystem };
  }

  it("turns a shell write to an open document into a merge", async () => {
    const { inner, registry, document, fileSystem } = open("alpha\nbeta\ngamma\n");
    await inner.writeFile("/doc.txt", "alpha\nbeta\ngamma\n");
    registry.open("/doc.txt", document, inner.stat("/doc.txt").mutationToken);

    // Someone is mid-edit when a script rewrites the same file.
    document.type(0, "# ");
    registry.markDirty("/doc.txt");

    const shell = new Shell({ fileSystem, commands: defaultShellCommands });
    const result = await shell.executeText({ script: `sed -i 's/beta/BETA/' /doc.txt`, cwd: "/" });

    expect(result.exitCode).toBe(0);
    // Both survive: the substitution did not discard the heading, and the
    // heading did not lose the substitution.
    expect(document.text()).toBe("# alpha\nBETA\ngamma\n");
    // And nothing reached storage, because publishing is the host's to schedule.
    expect(await read(inner, "/doc.txt")).toBe("alpha\nbeta\ngamma\n");
  });

  it("lets a later command in the same unit see what the earlier one wrote", async () => {
    const { inner, registry, document, fileSystem } = open("one\ntwo\n");
    await inner.writeFile("/doc.txt", "one\ntwo\n");
    registry.open("/doc.txt", document, inner.stat("/doc.txt").mutationToken);

    const shell = new Shell({ fileSystem, commands: defaultShellCommands });
    // This is why flushing before an execution is not enough on its own: the
    // write happens during it.
    const result = await shell.executeText({
      script: `sed -i 's/two/TWO/' /doc.txt; cat /doc.txt; grep -c TWO /doc.txt`,
      cwd: "/",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("one\nTWO\n1\n");
  });

  it("reports a size that matches the bytes a read would serve", async () => {
    const { inner, registry, document, fileSystem } = open("short\n");
    await inner.writeFile("/doc.txt", "short\n");
    registry.open("/doc.txt", document, inner.stat("/doc.txt").mutationToken);
    document.type(6, "much longer now\n");
    registry.markDirty("/doc.txt");

    expect(fileSystem.stat("/doc.txt").sizeBytes).toBe(22);
    expect(await read(fileSystem, "/doc.txt")).toBe("short\nmuch longer now\n");
    // The namespace still holds what was published.
    expect(inner.stat("/doc.txt").sizeBytes).toBe(6);
  });

  it("appends to an open document rather than to storage", async () => {
    const { inner, registry, document, fileSystem } = open("head\n");
    await inner.writeFile("/doc.txt", "head\n");
    registry.open("/doc.txt", document, inner.stat("/doc.txt").mutationToken);

    const shell = new Shell({ fileSystem, commands: defaultShellCommands });
    await shell.executeText({ script: `printf 'tail\\n' >> /doc.txt`, cwd: "/" });
    expect(document.text()).toBe("head\ntail\n");
    expect(await read(inner, "/doc.txt")).toBe("head\n");
  });

  it("leaves files nobody has open entirely alone", async () => {
    const { inner, fileSystem } = open("");
    const shell = new Shell({ fileSystem, commands: defaultShellCommands });
    await shell.executeText({
      script: `printf 'plain\\n' > /other.txt; sed -i 's/plain/PLAIN/' /other.txt`,
      cwd: "/",
    });
    expect(await read(inner, "/other.txt")).toBe("PLAIN\n");
  });

  it("stays bound when a credential view is taken from it", async () => {
    const { inner, registry, document, fileSystem } = open("body\n");
    await inner.writeFile("/doc.txt", "body\n");
    inner.setOwnership("/doc.txt", { uid: 1000, gid: 1000 });
    registry.open("/doc.txt", document, inner.stat("/doc.txt").mutationToken);
    document.type(5, "edited\n");
    registry.markDirty("/doc.txt");

    inner.setMetadata("/doc.txt", { mode: 0o600 });

    // Still collaborative: the owner's view serves the unpublished text.
    const owner = fileSystem.forCredentials({ uid: 1000, gid: 1000 });
    expect(await read(owner, "/doc.txt")).toBe("body\nedited\n");

    // Still bound: decorating did not hand the document to someone the mode
    // refuses, which is the thing that would be easy to lose here.
    const stranger = fileSystem.forCredentials({ uid: 2000, gid: 2000 });
    expect(() => stranger.readFile("/doc.txt")).toThrow(
      expect.objectContaining({ code: "EACCES" }) as Error,
    );
  });
});

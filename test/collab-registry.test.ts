import { describe, expect, it } from "vitest";
import {
  applyTextEdits,
  type CollaborativeDocument,
  CollaborativeFileSystem,
  DocumentRegistry,
  type TextEdit,
  textEdits,
} from "../src/collab/index.js";
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

function delayNextRead(inner: ReturnType<typeof createTestFileSystem>) {
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const fileSystem = new Proxy(inner, {
    get(target, property) {
      if (property === "readFile") {
        return (path: string) => {
          const source = target.readFile(path);
          let delivered = false;
          return {
            stat: source.stat,
            stream: new ReadableStream<Uint8Array>({
              async pull(controller) {
                if (delivered) return;
                delivered = true;
                started.resolve();
                await resume.promise;
                controller.enqueue(await readAllBytes(source.stream, 1 << 20));
                controller.close();
              },
            }),
          };
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { fileSystem, started: started.promise, resume };
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

it("closes an open destination replaced by a move", () => {
  const registry = new DocumentRegistry();
  registry.open("/destination.txt", new TextDocument("old"), "token");

  registry.observe({
    type: "vfs.mutation",
    op: "move",
    path: "/source.txt",
    subtree: { root: "/source.txt", to: "/destination.txt" },
  });

  expect(registry.paths()).toEqual([]);
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
  const view = new CollaborativeFileSystem(fileSystem, registry);
  const document = new TextDocument("body\n");
  registry.open("/doc.txt", document, fileSystem.stat("/doc.txt").mutationToken);

  expect(await view.publish("/doc.txt")).toBe(false);

  document.type(5, "more\n");
  registry.markDirty("/doc.txt");
  const revisionBefore = fileSystem.stat("/doc.txt").revision;
  expect(await view.publish("/doc.txt")).toBe(true);
  expect(await read(fileSystem, "/doc.txt")).toBe("body\nmore\n");
  expect(fileSystem.stat("/doc.txt").revision).toBe(revisionBefore + 1);

  // A flush with nothing new publishes nothing, and one whose text happens
  // to match what is stored does not churn the revision either.
  expect(await view.publish("/doc.txt")).toBe(false);
  registry.markDirty("/doc.txt");
  const settled = fileSystem.stat("/doc.txt").revision;
  await view.publish("/doc.txt");
  expect(fileSystem.stat("/doc.txt").revision).toBe(settled);
});

it("keeps edits made while a publication is in flight dirty", async () => {
  const fileSystem = createTestFileSystem();
  await fileSystem.writeFile("/doc.txt", "body\n");
  const registry = new DocumentRegistry();
  const view = new CollaborativeFileSystem(fileSystem, registry);
  const document = new TextDocument("body\n");
  registry.open("/doc.txt", document, fileSystem.stat("/doc.txt").mutationToken);
  document.type(5, "first\n");
  registry.markDirty("/doc.txt");

  const publishing = view.publish("/doc.txt");
  document.type(document.text().length, "second\n");
  registry.markDirty("/doc.txt");
  await publishing;

  expect(registry.get("/doc.txt")?.dirty).toBe(true);
  expect(await read(fileSystem, "/doc.txt")).toBe("body\nfirst\n");
  expect(await view.publish("/doc.txt")).toBe(true);
  expect(await read(fileSystem, "/doc.txt")).toBe("body\nfirst\nsecond\n");
});

it("refuses to publish over a change it did not see", async () => {
  const fileSystem = createTestFileSystem();
  await fileSystem.writeFile("/doc.txt", "body\n");
  const registry = new DocumentRegistry();
  const view = new CollaborativeFileSystem(fileSystem, registry);
  const document = new TextDocument("body\n");
  registry.open("/doc.txt", document, fileSystem.stat("/doc.txt").mutationToken);

  await fileSystem.writeFile("/doc.txt", "someone else\n");
  document.type(0, "mine ");
  registry.markDirty("/doc.txt");

  await expect(view.publish("/doc.txt")).rejects.toMatchObject({
    code: "EREVISION",
  });

  // Reconciling is what a caller does with that, and the local edit survives.
  expect(await view.reconcile("/doc.txt")).toBe(true);
  registry.markDirty("/doc.txt");
  expect(await view.publish("/doc.txt")).toBe(true);
  expect(await read(fileSystem, "/doc.txt")).toBe("someone else\n");
  expect(document.external).toHaveLength(1);
});

it("keeps a locally merged reconciliation pending", async () => {
  const fileSystem = createTestFileSystem();
  await fileSystem.writeFile("/doc.txt", "base\n");
  const registry = new DocumentRegistry();
  const view = new CollaborativeFileSystem(fileSystem, registry);
  let text = "base\nlocal\n";
  const document: CollaborativeDocument = {
    text: () => text,
    applyExternal: (edits) => {
      text = `${applyTextEdits(text, edits)}local\n`;
    },
  };
  registry.open("/doc.txt", document, fileSystem.stat("/doc.txt").mutationToken);
  registry.markDirty("/doc.txt");
  await fileSystem.writeFile("/doc.txt", "remote\n");

  expect(await view.reconcile("/doc.txt")).toBe(true);
  expect(document.text()).toBe("remote\nlocal\n");
  expect(registry.get("/doc.txt")?.dirty).toBe(true);
  expect(await view.publish("/doc.txt")).toBe(true);
  expect(await read(fileSystem, "/doc.txt")).toBe("remote\nlocal\n");
});

it("does not reconcile into a document that closed while storage was being read", async () => {
  const inner = createTestFileSystem();
  await inner.writeFile("/doc.txt", "stored\n");
  const delayed = delayNextRead(inner);
  const registry = new DocumentRegistry();
  const closed = new TextDocument("closed\n");
  registry.open("/doc.txt", closed, inner.stat("/doc.txt").mutationToken);
  const view = new CollaborativeFileSystem(delayed.fileSystem, registry);

  const reconciling = view.reconcile("/doc.txt");
  await delayed.started;
  registry.close("/doc.txt");
  registry.open("/doc.txt", closed, inner.stat("/doc.txt").mutationToken);
  delayed.resume.resolve();

  await expect(reconciling).resolves.toBe(false);
  expect(closed.text()).toBe("closed\n");
});

it("does not let a stale reconciliation undo an in-flight publication", async () => {
  const inner = createTestFileSystem();
  await inner.writeFile("/doc.txt", "old\n");
  const delayed = delayNextRead(inner);
  const registry = new DocumentRegistry();
  const document = new TextDocument("old\n");
  registry.open("/doc.txt", document, inner.stat("/doc.txt").mutationToken);
  const view = new CollaborativeFileSystem(delayed.fileSystem, registry);

  const reconciling = view.reconcile("/doc.txt");
  await delayed.started;
  document.type(0, "new\n");
  registry.markDirty("/doc.txt");
  await expect(view.publish("/doc.txt")).resolves.toBe(true);
  const publishedToken = inner.stat("/doc.txt").mutationToken;
  delayed.resume.resolve();

  await expect(reconciling).resolves.toBe(false);
  expect(document.text()).toBe("new\nold\n");
  expect(await read(inner, "/doc.txt")).toBe("new\nold\n");
  expect(registry.get("/doc.txt")?.token).toBe(publishedToken);
});

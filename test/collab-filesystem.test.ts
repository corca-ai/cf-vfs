import { describe, expect, it } from "vitest";
import {
  applyTextEdits,
  type CollaborativeDocument,
  CollaborativeFileSystem,
  DocumentRegistry,
  type TextEdit,
} from "../src/collab/index.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { Shell } from "../src/shell/shell.js";
import { readAllBytes } from "../src/vfs/streams.js";
import { createTestFileSystem, withoutPosixCredentials } from "./helpers/node-sql.js";

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

describe("collaborative filesystem capabilities", () => {
  it("refuses a credential view when the wrapped filesystem does not provide one", () => {
    const fileSystem = new CollaborativeFileSystem(
      withoutPosixCredentials(createTestFileSystem()),
      new DocumentRegistry(),
    );

    expect(() => fileSystem.forCredentials({ uid: 1_000, gid: 1_000 })).toThrowError(
      "the underlying filesystem does not support POSIX credentials",
    );
  });
});

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
  expect(fileSystem.lstat("/doc.txt").sizeBytes).toBe(22);
  expect(await read(fileSystem, "/doc.txt")).toBe("short\nmuch longer now\n");
  // The namespace still holds what was published.
  expect(inner.stat("/doc.txt").sizeBytes).toBe(6);
});

it("reports pending document sizes through directory traversals", async () => {
  const { inner, registry, document, fileSystem } = open("short\n");
  await inner.writeFile("/doc.txt", "short\n");
  registry.open("/doc.txt", document, inner.stat("/doc.txt").mutationToken);
  document.type(6, "한글\n");
  registry.markDirty("/doc.txt");

  const expectedSize = new TextEncoder().encode("short\n한글\n").byteLength;
  expect(fileSystem.list("/").find((entry) => entry.path === "/doc.txt")?.sizeBytes).toBe(
    expectedSize,
  );
  expect(
    fileSystem.listPage("/", { limit: 10 }).entries.find((entry) => entry.path === "/doc.txt")
      ?.sizeBytes,
  ).toBe(expectedSize);
  expect(fileSystem.find({ path: "/" }).find((entry) => entry.path === "/doc.txt")?.sizeBytes).toBe(
    expectedSize,
  );
  expect(
    fileSystem.findPage({ path: "/", limit: 10 }).entries.find((entry) => entry.path === "/doc.txt")
      ?.sizeBytes,
  ).toBe(expectedSize);
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

it("enforces write preconditions before editing an open document", async () => {
  const { inner, registry, document, fileSystem } = open("body\n");
  await inner.writeFile("/doc.txt", "body\n");
  registry.open("/doc.txt", document, inner.stat("/doc.txt").mutationToken);

  await expect(
    fileSystem.writeFile("/doc.txt", "replacement\n", { ifMutationToken: "stale" }),
  ).rejects.toMatchObject({ code: "EREVISION" });
  await expect(
    fileSystem.appendFile("/doc.txt", "addition\n", { ifMutationToken: "stale" }),
  ).rejects.toMatchObject({ code: "EREVISION" });
  await expect(
    fileSystem.writeFile("/doc.txt", "replacement\n", { disposition: "create" }),
  ).rejects.toMatchObject({ code: "EEXIST" });
  expect(document.text()).toBe("body\n");
});

it("keeps the publication token after an identical routed write", async () => {
  const { inner, registry, document, fileSystem } = open("body\n");
  await inner.writeFile("/doc.txt", "body\n");
  registry.open("/doc.txt", document, inner.stat("/doc.txt").mutationToken);

  await fileSystem.writeFile("/doc.txt", "body\n");
  document.type(5, "edited\n");
  registry.markDirty("/doc.txt");

  expect(await fileSystem.publish("/doc.txt")).toBe(true);
  expect(await read(inner, "/doc.txt")).toBe("body\nedited\n");
});

it("applies a requested mode alongside an open-document edit", async () => {
  const { inner, registry, document, fileSystem } = open("body\n");
  await inner.writeFile("/doc.txt", "body\n", { mode: 0o644 });
  registry.open("/doc.txt", document, inner.stat("/doc.txt").mutationToken);

  await fileSystem.writeFile("/doc.txt", "replacement\n", { mode: 0o600 });

  expect(inner.stat("/doc.txt").mode & 0o777).toBe(0o600);
  expect(document.text()).toBe("replacement\n");
  expect(registry.get("/doc.txt")?.dirty).toBe(true);
  expect(await fileSystem.publish("/doc.txt")).toBe(true);
  expect(await read(inner, "/doc.txt")).toBe("replacement\n");
});

it("refuses a stream write when the document was closed and reopened", async () => {
  const { inner, registry, document: closedDocument, fileSystem } = open("old\n");
  await inner.writeFile("/doc.txt", "old\n");
  registry.open("/doc.txt", closedDocument, inner.stat("/doc.txt").mutationToken);
  let deliver!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      deliver = () => {
        controller.enqueue(new TextEncoder().encode("replacement\n"));
        controller.close();
      };
    },
  });

  const writing = fileSystem.writeFile("/doc.txt", body);
  registry.close("/doc.txt");
  const currentDocument = new TextDocument("old\n");
  registry.open("/doc.txt", currentDocument, inner.stat("/doc.txt").mutationToken);
  deliver();
  await expect(writing).rejects.toMatchObject({ code: "EREVISION" });

  expect(closedDocument.text()).toBe("old\n");
  expect(currentDocument.text()).toBe("old\n");
  expect(registry.get("/doc.txt")?.dirty).toBe(false);
});

it("reports the size produced by a merging document", async () => {
  const inner = createTestFileSystem();
  await inner.writeFile("/doc.txt", "base\n");
  const registry = new DocumentRegistry();
  let text = "base\nlocal\n";
  const document: CollaborativeDocument = {
    text: () => text,
    applyExternal: (edits) => {
      text = `${applyTextEdits(text, edits)}local\n`;
    },
  };
  registry.open("/doc.txt", document, inner.stat("/doc.txt").mutationToken);
  registry.markDirty("/doc.txt");
  const fileSystem = new CollaborativeFileSystem(inner, registry);

  const result = await fileSystem.writeFile("/doc.txt", "remote\n");

  expect(document.text()).toBe("remote\nlocal\n");
  expect(result.sizeBytes).toBe(new TextEncoder().encode(document.text()).byteLength);
});

it("ranges pending reads and includes pending bytes in subtree summaries", async () => {
  const inner = createTestFileSystem();
  await inner.writeFile("/dir/doc.txt", "old", { createParents: true });
  const registry = new DocumentRegistry();
  const document = new TextDocument("pending");
  registry.open("/dir/doc.txt", document, inner.stat("/dir/doc.txt").mutationToken);
  registry.markDirty("/dir/doc.txt");
  const fileSystem = new CollaborativeFileSystem(inner, registry);

  const ranged = fileSystem.readFile("/dir/doc.txt", { range: { suffix: 3 } });
  expect(ranged.stat.sizeBytes).toBe(7);
  expect(await new Response(ranged.stream).text()).toBe("ing");
  expect(fileSystem.subtreeSummary("/dir")).toEqual({
    entries: 2,
    inlineBytes: 3,
    logicalFileBytes: 7,
  });
});

it("digests unpublished document bytes rather than the stored revision", async () => {
  const inner = createTestFileSystem();
  await inner.writeFile("/doc.txt", "stored");
  const registry = new DocumentRegistry();
  const document = new TextDocument("pending");
  registry.open("/doc.txt", document, inner.stat("/doc.txt").mutationToken);
  registry.markDirty("/doc.txt");
  const fileSystem = new CollaborativeFileSystem(inner, registry);

  expect(await fileSystem.digestFile("/doc.txt")).toBe(
    "62a2fed3d6e08c44835fce71f02210b1ddabfb066e39edf1e6c261988f824dd3",
  );
  expect(await fileSystem.digestFile("/doc.txt")).not.toBe(await inner.digestFile("/doc.txt"));
});

it("keeps open documents current across metadata mutations", async () => {
  const { inner, registry, fileSystem } = open("");
  const paths = ["/touched.txt", "/moded.txt", "/owned.txt"] as const;
  for (const path of paths) {
    await inner.writeFile(path, "old\n");
    const document = new TextDocument("old\npending\n");
    registry.open(path, document, inner.stat(path).mutationToken);
    registry.markDirty(path);
  }

  const changed = [
    fileSystem.touch(paths[0], { modifiedAtMs: 1234 }),
    fileSystem.setMetadata(paths[1], { mode: 0o600 }),
    fileSystem.setOwnership(paths[2], { uid: 1000, gid: 1000 }),
  ];
  const pendingSize = new TextEncoder().encode("old\npending\n").byteLength;
  for (const [index, path] of paths.entries()) {
    expect(changed[index]?.sizeBytes).toBe(pendingSize);
    expect(registry.get(path)?.token).toBe(inner.getMutationToken(path));
    expect(changed[index]?.mutationToken).toBe(fileSystem.getMutationToken(path));
    expect(registry.get(path)?.dirty).toBe(true);
    expect(await fileSystem.publish(path)).toBe(true);
    expect(await read(inner, path)).toBe("old\npending\n");
  }
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

it("refuses a batch that spans an open document, published or not", async () => {
  const { inner, registry, document, fileSystem } = open("body\n");
  await inner.writeFile("/doc.txt", "body\n");
  registry.open("/doc.txt", document, inner.stat("/doc.txt").mutationToken);

  // A batch promises that a failure leaves every path as it was, and that
  // rests on one transaction. The document is not in it, so the set cannot
  // be one change and is refused rather than half kept.
  await expect(
    fileSystem.writeFiles([
      { path: "/plain.txt", body: "plain\n" },
      { path: "/doc.txt", body: "replacement\n" },
    ]),
  ).rejects.toMatchObject({ code: "ENOTSUP", path: "/doc.txt" });
  expect(inner.list("/").map((entry) => entry.path)).toEqual(["/doc.txt"]);
  expect(document.text()).toBe("body\n");

  // Publishing does not lift the refusal, and must not: it records the token
  // and clears the dirty flag but leaves the document open, and a read of an
  // open document is still served from the document.
  document.type(5, "edited\n");
  registry.markDirty("/doc.txt");
  expect(await fileSystem.publish("/doc.txt")).toBe(true);
  await expect(
    fileSystem.writeFiles([{ path: "/doc.txt", body: "replacement\n" }]),
  ).rejects.toMatchObject({ code: "ENOTSUP", path: "/doc.txt" });

  // Closing does, which is one of the two routes the refusal points at.
  registry.close("/doc.txt");
  await fileSystem.writeFiles([
    { path: "/doc.txt", body: "batched\n" },
    { path: "/plain.txt", body: "plain\n" },
  ]);
  expect(await read(inner, "/doc.txt")).toBe("batched\n");
  expect(await read(inner, "/plain.txt")).toBe("plain\n");
});

it("reconciles an open document with a batch written underneath this view", async () => {
  const { inner, registry, document, fileSystem } = open("body\n");
  await inner.writeFile("/doc.txt", "body\n");
  registry.open("/doc.txt", document, inner.stat("/doc.txt").mutationToken);

  // The other route: the batch goes to the filesystem underneath, which owes
  // the document nothing, and each open document is brought up to date after
  // it -- what `reconcile` exists for.
  await inner.writeFiles([
    { path: "/doc.txt", body: "reconciled\n" },
    { path: "/other.txt", body: "other\n" },
  ]);
  expect(await fileSystem.reconcile("/doc.txt")).toBe(true);

  expect(document.text()).toBe("reconciled\n");
  expect(document.external).toHaveLength(1);
  expect(registry.get("/doc.txt")?.token).toBe(inner.stat("/doc.txt").mutationToken);
  expect(await read(inner, "/other.txt")).toBe("other\n");
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

  await expect(stranger.writeFile("/doc.txt", "intrusion\n")).rejects.toMatchObject({
    code: "EACCES",
  });
  await expect(stranger.appendFile("/doc.txt", "intrusion\n")).rejects.toMatchObject({
    code: "EACCES",
  });
  expect(document.text()).toBe("body\nedited\n");
});

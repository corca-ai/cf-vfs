import { expect, it } from "vitest";
import {
  applyTextEdits,
  CollaborativeFileSystem,
  DocumentRegistry,
  type TextEdit,
  textEdits,
} from "../src/collab/index.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

class Document {
  constructor(public value: string) {}
  text() {
    return this.value;
  }
  applyExternal(edits: readonly TextEdit[]) {
    this.value = applyTextEdits(this.value, edits);
  }
}
async function setup(options: Parameters<typeof createTestFileSystem>[0] = {}) {
  const registry = new DocumentRegistry();
  const fs = createTestFileSystem({ ...options, onEvent: (event) => registry.observe(event) });
  await fs.writeFile("/doc", "a\nb\n");
  const doc = new Document("a\nb\n");
  registry.open("/doc", doc, fs.stat("/doc").mutationToken);
  return { registry, fs, doc, view: new CollaborativeFileSystem(fs, registry) };
}
it.each(["writeFile", "appendFile"] as const)(
  "enforces prebound credentials for %s",
  async (operation) => {
    const { fs, registry, doc } = await setup();
    fs.setMetadata("/doc", { mode: 0o444 });
    const view = new CollaborativeFileSystem(fs.forCredentials({ uid: 1000, gid: 1000 }), registry);
    await expect(view[operation]("/doc", "attack")).rejects.toMatchObject({ code: "EACCES" });
    expect(doc.text()).toBe("a\nb\n");
  },
);
it.each([
  { maxInlineFileBytes: 4, code: "EFBIG" },
  { maxInlineLogicalBytes: 4, code: "ENOSPC" },
])("enforces deferred write quota $code", async ({ code, ...options }) => {
  const { view, doc } = await setup(options);
  await expect(view.writeFile("/doc", "oversized")).rejects.toMatchObject({ code });
  expect(doc.text()).toBe("a\nb\n");
});
it("rejects stale guarded writes after a document edit", async () => {
  const { view, doc, registry } = await setup();
  const token = view.getMutationToken("/doc");
  doc.value = "local a\nb\n";
  registry.markDirty("/doc");
  await expect(view.writeFile("/doc", "a\nB\n", { ifMutationToken: token })).rejects.toMatchObject({
    code: "EREVISION",
  });
  expect(doc.text()).toBe("local a\nb\n");
});
it("merges independent local and stored edits", async () => {
  const { fs, view, doc, registry } = await setup();
  doc.value = "local a\nb\n";
  registry.markDirty("/doc");
  await fs.writeFile("/doc", "a\nremote b\n");
  await view.reconcile("/doc");
  expect(doc.text()).toBe("local a\nremote b\n");
  expect(registry.get("/doc")?.dirty).toBe(true);
  await view.publish("/doc");
  expect(registry.get("/doc")?.dirty).toBe(false);
});
it("preserves local text on overlapping reconciliation", async () => {
  const { fs, view, doc, registry } = await setup();
  doc.value = "local a\nb\n";
  registry.markDirty("/doc");
  await fs.writeFile("/doc", "remote a\nb\n");
  await expect(view.reconcile("/doc")).rejects.toMatchObject({ code: "EREVISION" });
  expect(doc.text()).toBe("local a\nb\n");
  expect(registry.get("/doc")?.dirty).toBe(true);
});
it("refreshes a moved document token past destination tombstones", async () => {
  const { fs, view, doc, registry } = await setup();
  await fs.writeFile("/dest", "first");
  await fs.writeFile("/dest", "second");
  await fs.remove("/dest");
  await view.move("/doc", "/dest");
  doc.value = "edited";
  registry.markDirty("/dest");
  await expect(view.publish("/dest")).resolves.toBe(true);
  expect(fs.stat("/dest").sizeBytes).toBe(6);
});

it("counts pending growth in other documents against the workspace", async () => {
  const { fs, view, registry } = await setup({ maxInlineLogicalBytes: 12 });
  await fs.writeFile("/other", "a\nb\n");
  registry.open("/other", new Document("a\nb\n"), fs.stat("/other").mutationToken);
  await view.writeFile("/doc", "12345678");
  await expect(view.writeFile("/other", "12345")).rejects.toMatchObject({ code: "ENOSPC" });
  expect(registry.get("/other")?.document.text()).toBe("a\nb\n");
});

it("refuses stale stream results without overwriting edits made during collection", async () => {
  const { view, registry, doc } = await setup();
  let deliver!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      deliver = () => {
        controller.enqueue(new TextEncoder().encode("streamed"));
        controller.close();
      };
    },
  });
  const writing = view.writeFile("/doc", body);
  doc.value = "local";
  registry.markDirty("/doc");
  deliver();
  await expect(writing).rejects.toMatchObject({ code: "EREVISION" });
  expect(doc.text()).toBe("local");
});

it("accepts guards from metadata results in subsequent document writes", async () => {
  const { view, doc } = await setup();
  const stat = view.setMetadata("/doc", {
    mode: 0o600,
    ifMutationToken: view.stat("/doc").mutationToken,
  });
  await view.writeFile("/doc", "new", { ifMutationToken: stat.mutationToken });
  expect(doc.text()).toBe("new");
});

it("applies an existing file's POSIX write mode rules through either wrapper order", async () => {
  const { fs, registry, doc } = await setup();
  fs.setOwnership("/doc", { uid: 1000, gid: 1000 });
  fs.setMetadata("/doc", { mode: 0o600 });
  const view = new CollaborativeFileSystem(fs.forCredentials({ uid: 1000, gid: 1000 }), registry);
  await view.writeFile("/doc", "new", { mode: 0o777 });
  expect(doc.text()).toBe("new");
  expect(fs.stat("/doc").mode).toBe(0o600);
});

it("uses original-text offsets for separated edits", () => {
  const before = "a\nb\nc\nd\n";
  const after = "extra\na\nb\nC\nd\n";
  const edits = textEdits(before, after);
  let result = before;
  for (const edit of [...edits].reverse())
    result = result.slice(0, edit.offset) + edit.insert + result.slice(edit.offset + edit.remove);
  expect(result).toBe(after);
  expect(applyTextEdits(before, edits)).toBe(after);
});

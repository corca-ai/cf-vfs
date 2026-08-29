import { afterEach, expect, it, vi } from "vitest";
import { DemoDocuments } from "../demo/document.js";
import { parseClientMessage } from "../demo/protocol.js";
import { CollaborativeFileSystem } from "../src/collab/index.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { Shell } from "../src/shell/shell.js";
import type { VfsEvent } from "../src/vfs/events.js";
import { readAllBytes } from "../src/vfs/streams.js";
import type { VirtualFileSystem } from "../src/vfs/types.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

/**
 * The demo's editing layer, driven the way the Durable Object drives it.
 *
 * The object itself is a WebSocket boundary and a workerd binding; what is
 * worth testing is underneath that — a shell command and a browser changing
 * the same file, and the namespace taking one away.
 */
const rooms: DemoDocuments[] = [];

// A scheduled publication outlives the test that armed it, and the shared
// helper closes the database in its own teardown. Cancelling here is what
// stops a timer firing into a closed one.
afterEach(() => {
  for (const documents of rooms) documents.dispose();
  rooms.length = 0;
  vi.useRealTimers();
});

function room(): {
  documents: DemoDocuments;
  storage: VirtualFileSystem;
  editable: CollaborativeFileSystem;
  notices: { path: string; kind: string; to?: string }[];
  shell: Shell;
  nextMutation: (path: string) => Promise<void>;
  nextNotice: (path: string) => Promise<void>;
} {
  const documents = new DemoDocuments();
  const notices: { path: string; kind: string; to?: string }[] = [];
  const mutationWaiters = new Map<string, Array<() => void>>();
  const noticeWaiters = new Map<string, Array<() => void>>();
  // The same wiring order the object uses: the sink is handed to the
  // filesystem, and the documents get the collaborative view back.
  const storage = createTestFileSystem({
    onEvent: (event: VfsEvent) => {
      documents.observe(event);
      if (event.type !== "vfs.mutation") return;
      const waiters = mutationWaiters.get(event.path);
      waiters?.shift()?.();
      if (waiters?.length === 0) mutationWaiters.delete(event.path);
    },
  });
  const editable = new CollaborativeFileSystem(storage, documents.registry);
  documents.attach(editable, (notice) => {
    notices.push({ ...notice });
    const waiters = noticeWaiters.get(notice.path);
    waiters?.shift()?.();
    if (waiters?.length === 0) noticeWaiters.delete(notice.path);
  });
  const shell = new Shell({ fileSystem: editable, commands: defaultShellCommands });
  const nextMutation = (path: string): Promise<void> =>
    new Promise((resolve) => {
      const waiters = mutationWaiters.get(path) ?? [];
      waiters.push(resolve);
      mutationWaiters.set(path, waiters);
    });
  const nextNotice = (path: string): Promise<void> =>
    new Promise((resolve) => {
      const waiters = noticeWaiters.get(path) ?? [];
      waiters.push(resolve);
      noticeWaiters.set(path, waiters);
    });
  rooms.push(documents);
  return { documents, storage, editable, notices, shell, nextMutation, nextNotice };
}

async function stored(fileSystem: VirtualFileSystem, path: string): Promise<string> {
  return new TextDecoder().decode(await readAllBytes(fileSystem.readFile(path).stream, 1 << 20));
}

it("merges a terminal write into a document someone is editing", async () => {
  vi.useFakeTimers();
  const { documents, storage, notices, shell, nextMutation } = room();
  await storage.writeFile("/doc.txt", "alpha\nbeta\ngamma\n");
  const document = await documents.open("/doc.txt");

  // A visitor types a heading and it reaches the server.
  expect(documents.applyClientText("/doc.txt", document.version(), "# alpha\nbeta\ngamma\n")).toBe(
    "applied",
  );

  // Another visitor runs sed in the terminal against the same file.
  const result = await shell.executeText({ script: `sed -i 's/beta/BETA/' /doc.txt`, cwd: "/" });
  expect(result.exitCode).toBe(0);
  documents.noticeShellWrites();

  // Neither discarded the other.
  expect(document.text()).toBe("# alpha\nBETA\ngamma\n");
  // And whoever has it open is told, so the pane is not left stale.
  expect(notices).toContainEqual({ path: "/doc.txt", kind: "changed" });

  const published = nextMutation("/doc.txt");
  await vi.runOnlyPendingTimersAsync();
  await published;
  expect(await stored(storage, "/doc.txt")).toBe("# alpha\nBETA\ngamma\n");
});

it("tells a client working from a replaced version rather than taking its text", async () => {
  const { documents, storage } = room();
  await storage.writeFile("/doc.txt", "one\n");
  const document = await documents.open("/doc.txt");
  const base = document.version();

  expect(documents.applyClientText("/doc.txt", base, "one\ntwo\n")).toBe("applied");
  // A second client still holding the old version is refused, and the text
  // it typed is not applied over what the first one wrote.
  expect(documents.applyClientText("/doc.txt", base, "one\nsomething else\n")).toBe("stale");
  expect(document.text()).toBe("one\ntwo\n");
});

it("publishes once after a pause rather than on every keystroke", async () => {
  vi.useFakeTimers();
  const { documents, storage, nextMutation } = room();
  await storage.writeFile("/doc.txt", "");
  const document = await documents.open("/doc.txt");
  const revision = storage.stat("/doc.txt").revision;

  for (const text of ["a\n", "ab\n", "abc\n"]) {
    documents.applyClientText("/doc.txt", document.version(), text);
  }
  // Nothing written yet: three edits are still one pending publication.
  expect(storage.stat("/doc.txt").revision).toBe(revision);

  const published = nextMutation("/doc.txt");
  await vi.runOnlyPendingTimersAsync();
  await published;
  expect(await stored(storage, "/doc.txt")).toBe("abc\n");
  expect(storage.stat("/doc.txt").revision).toBe(revision + 1);
});

it("follows a document the terminal moved, and closes one it removed", async () => {
  const { documents, notices, shell, storage } = room();
  await storage.mkdir("/src", true);
  await storage.writeFile("/src/a.txt", "body\n");
  await documents.open("/src/a.txt");

  await shell.executeText({ script: `mv /src /lib`, cwd: "/" });
  expect(documents.openPaths()).toEqual(["/lib/a.txt"]);
  expect(notices).toContainEqual({ path: "/src/a.txt", kind: "moved", to: "/lib/a.txt" });

  await shell.executeText({ script: `rm -r /lib`, cwd: "/" });
  expect(documents.openPaths()).toEqual([]);
  expect(notices).toContainEqual({ path: "/lib/a.txt", kind: "gone" });
});

it("refuses a document larger than the room allows", async () => {
  const { documents, storage } = room();
  await storage.writeFile("/doc.txt", "");
  const document = await documents.open("/doc.txt");
  expect(() =>
    documents.applyClientText("/doc.txt", document.version(), "x".repeat(17 * 1024)),
  ).toThrow(expect.objectContaining({ code: "EFBIG" }) as Error);
});

it("republishes over a change made outside the document", async () => {
  vi.useFakeTimers();
  const { documents, storage, nextNotice } = room();
  await storage.writeFile("/doc.txt", "one\n");
  const document = await documents.open("/doc.txt");
  documents.applyClientText("/doc.txt", document.version(), "one\nedited\n");

  // A writer that is not going through the document at all — a caller
  // Worker, say — replaces the file before the flush lands.
  await storage.writeFile("/doc.txt", "replaced\n");

  const reconciled = nextNotice("/doc.txt");
  await vi.runOnlyPendingTimersAsync();
  await reconciled;
  // The publication was refused, the outside change was taken in, and the
  // result holds both rather than either being silently lost.
  expect(document.text()).toContain("replaced");
  expect(await stored(storage, "/doc.txt")).toBe(document.text());
});

it("parses the document messages the client sends", () => {
  expect(parseClientMessage(JSON.stringify({ type: "doc-open", path: "/a.txt" }))).toEqual({
    type: "doc-open",
    path: "/a.txt",
  });
  expect(parseClientMessage(JSON.stringify({ type: "doc-close", path: "/a.txt" }))).toEqual({
    type: "doc-close",
    path: "/a.txt",
  });
  expect(
    parseClientMessage(JSON.stringify({ type: "doc-edit", path: "/a.txt", base: 2, text: "x" })),
  ).toEqual({ type: "doc-edit", path: "/a.txt", base: 2, text: "x" });
});

it("refuses a base that is not a version it could have issued", () => {
  // `NaN` is the one that matters: it compares unequal to every version, so
  // a client sending it would resynchronize on every keystroke forever.
  for (const base of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, "2", null]) {
    const message = JSON.stringify({ type: "doc-edit", path: "/a.txt", base, text: "x" });
    expect(() => parseClientMessage(message), String(base)).toThrowError(/version/u);
  }
});

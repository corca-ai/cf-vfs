import { expect, it } from "vitest";
import type { VirtualFileSystem } from "../../src/vfs/types.js";
import { readAllBytes } from "../../src/vfs/streams.js";

export type VfsFactory = () => VirtualFileSystem | Promise<VirtualFileSystem>;

export function runVfsConformance(
  factory: VfsFactory,
  options: { negativeMutationRaces?: boolean } = {},
): void {
  it("conforms: preserves arbitrary bytes through streamed snapshots", async () => {
    const fileSystem = await factory();
    const original = Uint8Array.of(0, 0xff, 0x80, 0x0a, 0);
    await fileSystem.writeFile("/bytes", new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of original) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }));
    const snapshot = await fileSystem.readFile("/bytes");
    await fileSystem.writeFile("/bytes", Uint8Array.of(9));

    expect([...await readAllBytes(snapshot.stream, 16)]).toEqual([...original]);
    expect([...await readAllBytes((await fileSystem.readFile("/bytes")).stream, 16)])
      .toEqual([9]);
  });

  it("conforms: accepts the current mutation token and publishes a new one", async () => {
    const fileSystem = await factory();
    await fileSystem.writeFile("/guarded", "old");
    const token = await fileSystem.getMutationToken("/guarded");
    const result = await fileSystem.writeFile("/guarded", "new", { ifMutationToken: token });
    expect(result.mutationToken).not.toBe(token);
    expect(new TextDecoder().decode(
      await readAllBytes((await fileSystem.readFile("/guarded")).stream, 16),
    )).toBe("new");
  });

  if (options.negativeMutationRaces !== false) it("conforms: rejects copying a path onto itself without changing its contents", async () => {
    const fileSystem = await factory();
    await fileSystem.writeFile("/same", "body");
    const before = await fileSystem.stat("/same");

    const copyError = await Promise.resolve()
      .then(() => fileSystem.copy("/same", "/same", { replace: true }))
      .then(() => null, (error: unknown) => error);
    expect(copyError).toMatchObject({ code: "EINVAL", path: "/same" });

    expect(await fileSystem.stat("/same")).toEqual(before);
    expect(new TextDecoder().decode(
      await readAllBytes((await fileSystem.readFile("/same")).stream, 16),
    )).toBe("body");
  });

  if (options.negativeMutationRaces !== false) it("conforms: rechecks the path token after collecting an empty append", async () => {
    const fileSystem = await factory();
    await fileSystem.writeFile("/append-race", "old");
    let finish: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        finish = () => controller.close();
      },
    });

    const appending = fileSystem.appendFile("/append-race", body);
    const observed = appending.then(() => null, (error: unknown) => error);
    await Promise.resolve();
    await fileSystem.touch("/append-race");
    finish?.();

    expect(await observed).toMatchObject({ code: "EREVISION", path: "/append-race" });
  });

  it("conforms: applies namespace operations and paginated traversal consistently", async () => {
    const fileSystem = await factory();
    await fileSystem.mkdir("/tree", true);
    await fileSystem.writeFile("/tree/a", "a");
    await fileSystem.copy("/tree/a", "/tree/b");
    await fileSystem.move("/tree/b", "/tree/c");

    const first = await fileSystem.listPage("/tree", { limit: 1 });
    expect(first.entries).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    if (first.nextCursor === null) throw new Error("expected a second conformance page");
    const second = await fileSystem.listPage("/tree", {
      cursor: first.nextCursor,
      limit: 1,
    });
    expect([...first.entries, ...second.entries].map((entry) => entry.path))
      .toEqual(["/tree/a", "/tree/c"]);

    expect(await fileSystem.remove("/tree", { recursive: true })).toMatchObject({ removed: 3 });
    expect((await fileSystem.list("/")).map((entry) => entry.path)).not.toContain("/tree");
  });
}

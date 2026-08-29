import { describe, expect, it } from "vitest";
import { createBashHarness } from "./helpers/bash.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

describe("symlink policy", () => {
  it("cannot be escaped through a link", async () => {
    const harness = createBashHarness({
      policy: { writeRoots: ["/allowed"], readRoots: ["/allowed"] },
    });
    await harness.fileSystem.writeFile("/allowed/ok.txt", "in\n", { createParents: true });
    await harness.fileSystem.writeFile("/secret.txt", "out\n", { createParents: true });
    await harness.fileSystem.mkdir("/secrets", true);
    await harness.fileSystem.writeFile("/secrets/deep.txt", "deep\n");
    harness.fileSystem.symlink("/allowed/escape", "/secret.txt");
    harness.fileSystem.symlink("/allowed/escape-dir", "/secrets");

    expect((await harness.run("cat /allowed/ok.txt")).stdout).toBe("in\n");
    // Reading, writing, and reaching through a directory link all stop at the
    // root check, which is made against what the path resolves to.
    for (const script of [
      "cat /allowed/escape",
      "cat /allowed/escape-dir/deep.txt",
      "printf x > /allowed/escape",
      "ls /allowed/escape-dir",
    ]) {
      const result = await harness.run(script);
      expect(result.exitCode, script).not.toBe(0);
      expect(result.stdout, script).toBe("");
    }
    expect(await harness.readText("/secret.txt")).toBe("out\n");
  });

  it("still allows a link that points outside the roots to be removed", async () => {
    const harness = createBashHarness({
      policy: { writeRoots: ["/allowed"], readRoots: ["/allowed"] },
    });
    await harness.fileSystem.mkdir("/allowed", true);
    await harness.fileSystem.writeFile("/secret.txt", "out\n");

    // Creating an escaping link is allowed — a target is text, not an access.
    expect((await harness.run("ln -s /secret.txt /allowed/escape")).exitCode).toBe(0);
    // Following it is refused, but naming it is not: a link that could be made
    // and never removed would be a dead end rather than a protection.
    expect((await harness.run("cat /allowed/escape")).exitCode).not.toBe(0);
    expect((await harness.run("mv /allowed/escape /allowed/renamed")).exitCode).toBe(0);
    expect((await harness.run("readlink /allowed/renamed")).stdout).toBe("/secret.txt\n");
    expect((await harness.run("rm /allowed/renamed")).exitCode).toBe(0);
    expect((await harness.run("ls /allowed")).stdout).toBe("");
    // And the target was never touched.
    expect(await harness.readText("/secret.txt")).toBe("out\n");
  });

  it("refuses to place an entry under a link that replaced its parent", async () => {
    const fileSystem = createTestFileSystem();
    await fileSystem.mkdir("/directory", true);
    await fileSystem.mkdir("/elsewhere", true);

    // The body is still arriving when the parent is swapped for a link. The
    // write resolved `/directory/new` before that happened, so nothing it
    // captured can notice — the refusal has to come from the parent check.
    let deliver = (): void => {};
    const arrival = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await arrival;
        controller.enqueue(new TextEncoder().encode("body"));
        controller.close();
      },
    });
    const writing = fileSystem.writeFile("/directory/new", body);
    await fileSystem.remove("/directory", { recursive: true });
    await fileSystem.symlink("/directory", "/elsewhere");
    deliver();

    await expect(writing).rejects.toMatchObject({ code: "ENOTDIR" });
    // A link that resolves to a directory is still not one, so no row may name
    // it as a parent: the link can be repointed and the child would remain.
    expect(() => fileSystem.stat("/directory/new")).toThrow();
    expect(fileSystem.list("/elsewhere")).toEqual([]);
  });
});

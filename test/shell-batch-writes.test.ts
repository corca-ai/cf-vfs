import { expect, it } from "vitest";
import { defineApplet } from "../src/shell/commands/applet.js";
import { Shell } from "../src/shell/shell.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

it.each(["root", "device", "mutations"] as const)(
  "refuses an entire scoped write batch at the %s boundary",
  async (boundary) => {
    const vfs = createTestFileSystem();
    vfs.mkdir("/repo");
    const second =
      boundary === "root" ? "/outside" : boundary === "device" ? "/dev/null" : "/repo/b";
    const probe = defineApplet(
      { name: "probe", usage: "", summary: "checks scoped batches" },
      async (context) => {
        if (context.fileSystem.writeFiles === undefined)
          throw new Error("missing batch capability");
        await context.fileSystem.writeFiles([
          { path: "/repo/a", body: "a" },
          { path: second, body: "b" },
        ]);
        return 0;
      },
    );
    const shell = new Shell({
      fileSystem: vfs,
      commands: [probe],
      ...(boundary === "root" ? { policy: { writeRoots: ["/repo"] } } : {}),
      ...(boundary === "mutations" ? { limits: { maxMutations: 1 } } : {}),
    });
    const result = await shell.executeText({ script: "probe" });
    expect(result.exitCode).toBe(boundary === "root" ? 126 : 1);
    expect(() => vfs.stat("/repo/a")).toThrow(/no such/);
    expect(() => vfs.stat(second)).toThrow(/no such/);
  },
);

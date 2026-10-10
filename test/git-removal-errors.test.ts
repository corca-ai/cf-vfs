import { expect, it } from "vitest";
import { defineApplet } from "../src/shell/commands/applet.js";
import { GitFileSystem } from "../src/shell/commands/git-fs.js";
import { Shell } from "../src/shell/shell.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

it.each([
  ["unlink", "/readonly/file", "EACCES"],
  ["rmdir", "/nonempty", "ENOTEMPTY"],
] as const)(
  "propagates %s failures and keeps them fatal for Git",
  async (operation, path, code) => {
    const vfs = createTestFileSystem();
    vfs.setMetadata("/", { mode: 0o40777 });
    await vfs.writeFile("/readonly/file", "protected", { createParents: true });
    vfs.setMetadata("/readonly", { mode: 0o40555 });
    await vfs.writeFile("/nonempty/file", "present", { createParents: true });
    const probe = defineApplet(
      { name: "probe", usage: "", summary: "checks Git removal failures" },
      async (context) => {
        const fs = new GitFileSystem(context);
        await expect(fs.promises[operation](path)).rejects.toMatchObject({ code });
        expect(() => fs.check()).toThrow(expect.objectContaining({ code }));
        return 0;
      },
    );
    const shell = new Shell({
      fileSystem: vfs.forCredentials({ uid: 1000, gid: 1000 }),
      commands: [probe],
    });
    const result = await shell.executeText({ script: "probe" });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await new Response(vfs.readFile("/readonly/file").stream).text()).toBe("protected");
    expect(vfs.stat("/nonempty/file").kind).toBe("file");
  },
);

import { describe, expect, it } from "vitest";
import {
  DEMO_CREDENTIALS,
  DEMO_IDENTITY_RESOLVER,
  DEMO_USER,
  ensureDemoOwnership,
  migrateDemoOwnership,
} from "../demo/identity.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { provisionLinuxFilesystem } from "../src/shell/linux.js";
import { Shell } from "../src/shell/shell.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

describe("demo identity", () => {
  it("migrates existing files and exposes host-provided user and group names", async () => {
    const fileSystem = createTestFileSystem();
    provisionLinuxFilesystem(fileSystem, { user: DEMO_USER });
    await fileSystem.writeFile("/home/demo/README.txt", "demo");
    await fileSystem.writeFile("/legacy.txt", "legacy");
    fileSystem.symlink("/dangling", "/missing");

    expect(migrateDemoOwnership(fileSystem)).toBeGreaterThan(0);
    expect(migrateDemoOwnership(fileSystem)).toBe(0);
    expect(fileSystem.stat("/legacy.txt")).toMatchObject({
      uid: DEMO_CREDENTIALS.uid,
      gid: DEMO_CREDENTIALS.gid,
    });
    expect(fileSystem.lstat("/dangling")).toMatchObject({ uid: 0, gid: 0 });

    await fileSystem.writeFile("/recreated.txt", "new");
    expect(ensureDemoOwnership(fileSystem, [fileSystem.stat("/recreated.txt")])).toBe(1);
    expect(ensureDemoOwnership(fileSystem, [fileSystem.stat("/recreated.txt")])).toBe(0);

    const shell = new Shell({
      fileSystem,
      commands: defaultShellCommands,
      identityResolver: DEMO_IDENTITY_RESOLVER,
    });
    await expect(
      shell.executeText({
        credentials: DEMO_CREDENTIALS,
        cwd: "/home/demo",
        script: [
          "id",
          "groups",
          "stat -c '%u:%g:%U:%G' README.txt",
          "printf writable > created.txt",
          "chown :demo created.txt",
          "stat -c '%U:%G:%a' created.txt",
        ].join("\n"),
      }),
    ).resolves.toEqual({
      exitCode: 0,
      stdout:
        "uid=1000(demo) gid=1000(demo) groups=1000(demo)\n" +
        "demo\n" +
        "1000:1000:demo:demo\n" +
        "demo:demo:644\n",
      stderr: "",
    });
  });
});

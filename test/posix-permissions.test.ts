import { describe, expect, it } from "vitest";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { modeString } from "../src/shell/commands/format.js";
import { Shell } from "../src/shell/shell.js";
import { readAllBytes } from "../src/vfs/streams.js";
import type {
  PosixCredentials,
  PosixVirtualFileSystem,
  VirtualFileSystem,
} from "../src/vfs/types.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

const USER: PosixCredentials = { uid: 1_000, gid: 10, supplementaryGids: [20] };
const OTHER: PosixCredentials = { uid: 2_000, gid: 30, supplementaryGids: [] };
const ROOT: PosixCredentials = { uid: 0, gid: 0, supplementaryGids: [] };

function view(
  fileSystem: PosixVirtualFileSystem,
  credentials: PosixCredentials,
  umask = 0o022,
): VirtualFileSystem {
  return fileSystem.forCredentials(credentials, { umask });
}

async function text(fileSystem: VirtualFileSystem, path: string): Promise<string> {
  return new TextDecoder().decode(await readAllBytes(fileSystem.readFile(path).stream, 1024));
}

function prepareHome(fileSystem: PosixVirtualFileSystem): void {
  fileSystem.mkdir("/home");
  fileSystem.setOwnership("/home", { uid: USER.uid, gid: USER.gid });
  fileSystem.setMetadata("/home", { mode: 0o040700 });
}

describe("POSIX VFS views", () => {
  it("validates numeric identities and umasks at the trust boundary", () => {
    const fileSystem = createTestFileSystem();
    expect(() => fileSystem.forCredentials({ uid: -1, gid: 0 })).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(() => fileSystem.forCredentials({ uid: 0, gid: 0 }, { umask: 0o1000 })).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(() => fileSystem.setOwnership("/", { uid: 0x1_0000_0000 })).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
  });

  it("assigns ownership, applies umask, and selects exactly one permission class", async () => {
    const fileSystem = createTestFileSystem();
    prepareHome(fileSystem);
    const user = view(fileSystem, USER, 0o027);

    await user.writeFile("/home/new", "body", { mode: 0o100666 });
    expect(fileSystem.stat("/home/new")).toMatchObject({
      uid: USER.uid,
      gid: USER.gid,
      mode: 0o100640,
    });

    fileSystem.setMetadata("/home/new", { mode: 0o100004 });
    await expect(text(user, "/home/new")).rejects.toMatchObject({ code: "EACCES" });

    await fileSystem.writeFile("/group-readable", "group");
    fileSystem.setOwnership("/group-readable", { uid: OTHER.uid, gid: 20 });
    fileSystem.setMetadata("/group-readable", { mode: 0o100040 });
    await expect(text(user, "/group-readable")).resolves.toBe("group");

    fileSystem.setMetadata("/group-readable", { mode: 0o100004 });
    await expect(text(user, "/group-readable")).rejects.toMatchObject({ code: "EACCES" });
  });

  it("keeps recursively created parents usable under a restrictive umask", async () => {
    const fileSystem = createTestFileSystem();
    prepareHome(fileSystem);
    const user = view(fileSystem, USER, 0o777);

    await user.writeFile("/home/a/b/file", "x", { createParents: true });
    expect(fileSystem.stat("/home/a")).toMatchObject({
      uid: USER.uid,
      gid: USER.gid,
      mode: 0o040300,
    });
    expect(fileSystem.stat("/home/a/b").mode).toBe(0o040300);
    expect(fileSystem.stat("/home/a/b/file").mode).toBe(0o100000);
  });

  it("requires execute permission on every ancestor and lets uid 0 bypass DAC", async () => {
    const fileSystem = createTestFileSystem();
    await fileSystem.writeFile("/sealed/sub/file", "secret", { createParents: true });
    fileSystem.setOwnership("/sealed/sub/file", { uid: USER.uid });
    fileSystem.setMetadata("/sealed", { mode: 0o040700 });
    fileSystem.setMetadata("/sealed/sub/file", { mode: 0o100777 });

    const user = view(fileSystem, USER);
    expect(() => user.stat("/sealed/sub/file")).toThrowError(
      expect.objectContaining({ code: "EACCES", path: "/sealed/sub/file" }),
    );
    await expect(text(view(fileSystem, ROOT), "/sealed/sub/file")).resolves.toBe("secret");
  });

  it("checks both sides of a followed symbolic link", async () => {
    const fileSystem = createTestFileSystem();
    await fileSystem.writeFile("/sealed/file", "secret", { createParents: true });
    fileSystem.setMetadata("/sealed", { mode: 0o040700 });
    fileSystem.setMetadata("/sealed/file", { mode: 0o100644 });
    fileSystem.mkdir("/public");
    fileSystem.setMetadata("/public", { mode: 0o040755 });
    fileSystem.symlink("/public/link", "/sealed/file");
    const user = view(fileSystem, USER);

    expect(user.lstat("/public/link").kind).toBe("symlink");
    expect(user.readlink("/public/link")).toBe("/sealed/file");
    expect(() => user.stat("/public/link")).toThrowError(
      expect.objectContaining({ code: "EACCES" }),
    );

    fileSystem.mkdir("/hidden-links");
    fileSystem.setMetadata("/hidden-links", { mode: 0o040700 });
    fileSystem.mkdir("/open");
    await fileSystem.writeFile("/open/file", "visible");
    fileSystem.setMetadata("/open/file", { mode: 0o100666 });
    fileSystem.symlink("/hidden-links/link", "/open/file");
    expect(() => user.touch("/hidden-links/link")).toThrowError(
      expect.objectContaining({ code: "EACCES" }),
    );
  });

  it("limits chmod and chown to the owner, root, and the owner's own groups", async () => {
    const fileSystem = createTestFileSystem();
    prepareHome(fileSystem);
    await fileSystem.writeFile("/home/file", "x");
    fileSystem.setOwnership("/home/file", { uid: USER.uid, gid: USER.gid });
    const user = view(fileSystem, USER);

    expect(user.setMetadata("/home/file", { mode: 0o100600 }).mode).toBe(0o100600);
    expect(user.setOwnership("/home/file", { gid: 20 }).gid).toBe(20);
    expect(() => user.setOwnership("/home/file", { gid: 99 })).toThrowError(
      expect.objectContaining({ code: "EPERM" }),
    );
    expect(() => user.setOwnership("/home/file", { uid: OTHER.uid })).toThrowError(
      expect.objectContaining({ code: "EPERM" }),
    );

    const root = view(fileSystem, ROOT);
    expect(root.setOwnership("/home/file", { uid: OTHER.uid, gid: OTHER.gid })).toMatchObject({
      uid: OTHER.uid,
      gid: OTHER.gid,
    });
    expect(() => user.setMetadata("/home/file", { mode: 0o100644 })).toThrowError(
      expect.objectContaining({ code: "EPERM" }),
    );
  });

  it("inherits setgid directory groups and enforces sticky-directory removal", async () => {
    const fileSystem = createTestFileSystem();
    fileSystem.mkdir("/shared");
    fileSystem.setOwnership("/shared", { uid: 0, gid: 20 });
    fileSystem.setMetadata("/shared", { mode: 0o042770 });
    expect(modeString(fileSystem.stat("/shared").mode)).toBe("drwxrws---");
    const user = view(fileSystem, USER);

    user.mkdir("/shared/dir");
    await user.writeFile("/shared/file", "x");
    expect(fileSystem.stat("/shared/dir")).toMatchObject({ uid: USER.uid, gid: 20 });
    expect(fileSystem.stat("/shared/dir").mode & 0o2000).toBe(0o2000);
    expect(fileSystem.stat("/shared/file")).toMatchObject({ uid: USER.uid, gid: 20 });

    await fileSystem.writeFile("/source/plain/leaf", "x", { createParents: true });
    await user.copy("/source", "/shared/copy", { recursive: true });
    expect(fileSystem.stat("/shared/copy")).toMatchObject({ uid: USER.uid, gid: 20 });
    expect(fileSystem.stat("/shared/copy").mode & 0o2000).toBe(0o2000);
    expect(fileSystem.stat("/shared/copy/plain")).toMatchObject({ uid: USER.uid, gid: 20 });
    expect(fileSystem.stat("/shared/copy/plain").mode & 0o2000).toBe(0o2000);
    await user.writeFile("/shared/copy/plain/new", "x");
    expect(fileSystem.stat("/shared/copy/plain/new").gid).toBe(20);

    fileSystem.mkdir("/tmp");
    fileSystem.setMetadata("/tmp", { mode: 0o041777 });
    expect(modeString(fileSystem.stat("/tmp").mode)).toBe("drwxrwxrwt");
    await user.writeFile("/tmp/user-file", "x");
    await expect(view(fileSystem, OTHER).remove("/tmp/user-file")).rejects.toMatchObject({
      code: "EPERM",
    });
    await expect(user.remove("/tmp/user-file")).resolves.toMatchObject({ removed: 1 });
  });

  it("rechecks permissions after collecting a streamed replacement", async () => {
    const fileSystem = createTestFileSystem();
    prepareHome(fileSystem);
    await fileSystem.writeFile("/home/file", "old");
    fileSystem.setOwnership("/home/file", { uid: USER.uid, gid: USER.gid });
    fileSystem.setMetadata("/home/file", { mode: 0o100600 });
    const user = view(fileSystem, USER);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("new"));
        await gate;
        controller.close();
      },
    });

    const writing = user.writeFile("/home/file", body);
    await Promise.resolve();
    fileSystem.setMetadata("/home/file", { mode: 0o100400 });
    release?.();
    await expect(writing).rejects.toMatchObject({ code: "EREVISION" });
    await expect(text(fileSystem, "/home/file")).resolves.toBe("old");
  });

  it("preflights recursive operations without publishing a partial subtree", async () => {
    const fileSystem = createTestFileSystem();
    prepareHome(fileSystem);
    await fileSystem.writeFile("/home/tree/open/file", "open", { createParents: true });
    await fileSystem.writeFile("/home/tree/blocked/file", "blocked", {
      createParents: true,
    });
    for (const path of [
      "/home/tree",
      "/home/tree/open",
      "/home/tree/open/file",
      "/home/tree/blocked",
      "/home/tree/blocked/file",
    ]) {
      fileSystem.setOwnership(path, { uid: USER.uid, gid: USER.gid });
    }
    fileSystem.setMetadata("/home/tree", { mode: 0o040700 });
    fileSystem.setMetadata("/home/tree/open", { mode: 0o040700 });
    fileSystem.setMetadata("/home/tree/open/file", { mode: 0o100600 });
    fileSystem.setMetadata("/home/tree/blocked", { mode: 0o040100 });
    fileSystem.setMetadata("/home/tree/blocked/file", { mode: 0o100600 });
    const user = view(fileSystem, USER);

    expect(() => user.find({ path: "/home/tree" })).toThrowError(
      expect.objectContaining({ code: "EACCES" }),
    );
    await expect(user.copy("/home/tree", "/home/copy", { recursive: true })).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(() => fileSystem.stat("/home/copy")).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
    await expect(user.remove("/home/tree", { recursive: true })).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(fileSystem.stat("/home/tree/open/file").sizeBytes).toBe(4);
  });
});

describe("POSIX shell identity", () => {
  it("exposes id and groups and lets chown change only an allowed numeric group", async () => {
    const fileSystem = createTestFileSystem();
    prepareHome(fileSystem);
    const shell = new Shell({ fileSystem, commands: defaultShellCommands });
    const result = await shell.executeText({
      credentials: USER,
      umask: 0o027,
      script: [
        "id",
        "id -u",
        "id -g",
        "id -G",
        "groups",
        "printf data > /home/file",
        "chown :20 /home/file",
        "stat -c '%u:%g:%a' /home/file",
      ].join("\n"),
    });
    expect(result).toEqual({
      exitCode: 0,
      stdout: [
        "uid=1000 gid=10 groups=10,20",
        "1000",
        "10",
        "10 20",
        "10 20",
        "1000:20:640",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  it("uses credentials for test predicates and keeps shell policy mandatory for root", async () => {
    const fileSystem = createTestFileSystem();
    prepareHome(fileSystem);
    await fileSystem.writeFile("/home/owner-class", "x");
    fileSystem.setOwnership("/home/owner-class", { uid: USER.uid, gid: USER.gid });
    fileSystem.setMetadata("/home/owner-class", { mode: 0o100004 });
    const shell = new Shell({ fileSystem, commands: defaultShellCommands });
    await expect(
      shell.executeText({ script: "test -r /home/owner-class", credentials: USER }),
    ).resolves.toMatchObject({ exitCode: 1 });

    await fileSystem.writeFile("/secret", "hidden");
    const restricted = new Shell({
      fileSystem,
      commands: defaultShellCommands,
      policy: { readRoots: ["/allowed"] },
    });
    await expect(
      restricted.executeText({ script: "cat /secret", credentials: ROOT }),
    ).resolves.toMatchObject({
      exitCode: 126,
      stderr: expect.stringContaining("readable roots"),
    });
  });

  it("does not require subtree read permission merely to budget a rename", async () => {
    const fileSystem = createTestFileSystem();
    prepareHome(fileSystem);
    fileSystem.mkdir("/home/locked");
    fileSystem.setOwnership("/home/locked", { uid: USER.uid, gid: USER.gid });
    fileSystem.setMetadata("/home/locked", { mode: 0o040000 });
    const shell = new Shell({ fileSystem, commands: defaultShellCommands });

    await expect(
      shell.executeText({
        script: "mv /home/locked /home/moved",
        credentials: USER,
      }),
    ).resolves.toMatchObject({ exitCode: 0, stderr: "" });
    expect(fileSystem.stat("/home/moved").mode).toBe(0o040000);
  });

  it("refuses identity commands when the host supplied no credentials", async () => {
    const fileSystem = createTestFileSystem();
    const shell = new Shell({ fileSystem, commands: defaultShellCommands });
    await expect(shell.executeText({ script: "id" })).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("requires execution credentials"),
    });
  });
});

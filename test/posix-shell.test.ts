import { expect, it } from "vitest";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import type { IdentityIds, IdentityNames, ShellIdentityResolver } from "../src/shell/identity.js";
import { Shell } from "../src/shell/shell.js";
import type { PosixCredentials, PosixVirtualFileSystem } from "../src/vfs/types.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

const USER: PosixCredentials = { uid: 1_000, gid: 10, supplementaryGids: [20] };
const OTHER: PosixCredentials = { uid: 2_000, gid: 30, supplementaryGids: [] };
const ROOT: PosixCredentials = { uid: 0, gid: 0, supplementaryGids: [] };

interface IdentityCalls {
  ids: IdentityIds[];
  names: IdentityNames[];
}

function testIdentityResolver(calls: IdentityCalls): ShellIdentityResolver {
  const usersById = new Map([
    [USER.uid, "alice"],
    [OTHER.uid, "bob"],
  ]);
  const groupsById = new Map([
    [USER.gid, "staff"],
    [20, "developers"],
    [OTHER.gid, "guests"],
  ]);
  const usersByName = new Map([...usersById].map(([id, name]) => [name, id]));
  const groupsByName = new Map([...groupsById].map(([id, name]) => [name, id]));
  return {
    resolveIds(request) {
      calls.ids.push(request);
      return {
        users: new Map(
          request.uids.flatMap((id) => {
            const name = usersById.get(id);
            return name === undefined ? [] : [[id, name]];
          }),
        ),
        groups: new Map(
          request.gids.flatMap((id) => {
            const name = groupsById.get(id);
            return name === undefined ? [] : [[id, name]];
          }),
        ),
      };
    },
    resolveNames(request) {
      calls.names.push(request);
      return {
        users: new Map(
          request.users.flatMap((name) => {
            const id = usersByName.get(name);
            return id === undefined ? [] : [[name, id]];
          }),
        ),
        groups: new Map(
          request.groups.flatMap((name) => {
            const id = groupsByName.get(name);
            return id === undefined ? [] : [[name, id]];
          }),
        ),
      };
    },
  };
}

function prepareHome(fileSystem: PosixVirtualFileSystem): void {
  fileSystem.mkdir("/home");
  fileSystem.setOwnership("/home", { uid: USER.uid, gid: USER.gid });
  fileSystem.setMetadata("/home", { mode: 0o040700 });
}

it("keeps the numeric long-listing contract exact for files, directories, and links", async () => {
  const fileSystem = createTestFileSystem();
  fileSystem.mkdir("/dir");
  await fileSystem.writeFile("/file", "x");
  fileSystem.symlink("/link", "/file");
  fileSystem.setMetadata("/dir", { mode: 0o042770 });
  fileSystem.setMetadata("/file", { mode: 0o104754 });
  fileSystem.setOwnership("/dir", { uid: USER.uid, gid: 20 });
  fileSystem.setOwnership("/file", { uid: USER.uid, gid: 20 });
  const shell = new Shell({ fileSystem, commands: defaultShellCommands });

  await expect(shell.executeText({ script: "ls -n -d /dir /file /link" })).resolves.toEqual({
    exitCode: 0,
    stdout:
      "drwxrws--- 1000 20        0 /dir\n" +
      "-rwsr-xr-- 1000 20        1 /file\n" +
      "lrwxrwxrwx 0 0        5 /link -> /file\n",
    stderr: "",
  });
});

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
      "id -un",
      "id -Gn",
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
      "1000",
      "10 20",
      "10 20",
      "1000:20:640",
      "",
    ].join("\n"),
    stderr: "",
  });
});

it("uses host account names for display and named chown while keeping numeric formats stable", async () => {
  const fileSystem = createTestFileSystem();
  prepareHome(fileSystem);
  const calls: IdentityCalls = { ids: [], names: [] };
  const shell = new Shell({
    fileSystem,
    commands: defaultShellCommands,
    identityResolver: testIdentityResolver(calls),
  });
  const result = await shell.executeText({
    credentials: USER,
    script: [
      "printf data > /home/file",
      "ls -l /home/file",
      "ls -n /home/file",
      "stat -c '%u:%g:%U:%G' /home/file",
      "stat /home/file | sed -n '5,6p'",
      "id",
      "id -un",
      "id -gn",
      "id -Gn",
      "groups",
      "chown :developers /home/file",
      "stat -c '%u:%g:%U:%G' /home/file",
    ].join("\n"),
  });
  expect(result).toEqual({
    exitCode: 0,
    stdout: [
      "-rw-r--r-- alice staff        4 /home/file",
      "-rw-r--r-- 1000 10        4 /home/file",
      "1000:10:alice:staff",
      " Owner: 1000 (alice)",
      " Group: 10 (staff)",
      "uid=1000(alice) gid=10(staff) groups=10(staff),20(developers)",
      "alice",
      "staff",
      "staff developers",
      "staff developers",
      "1000:20:alice:developers",
      "",
    ].join("\n"),
    stderr: "",
  });
  expect(calls.ids).toEqual([
    { uids: [USER.uid], gids: [USER.gid] },
    { uids: [], gids: [20] },
  ]);
  expect(calls.names).toEqual([{ users: [], groups: ["developers"] }]);
});

it("resolves each unique owner once for a long listing and skips lookup for -n", async () => {
  const fileSystem = createTestFileSystem();
  prepareHome(fileSystem);
  for (let index = 0; index < 100; index += 1) {
    await fileSystem.writeFile(`/home/f${String(index).padStart(3, "0")}`, "x");
    fileSystem.setOwnership(`/home/f${String(index).padStart(3, "0")}`, {
      uid: index % 2 === 0 ? USER.uid : OTHER.uid,
      gid: index % 2 === 0 ? USER.gid : OTHER.gid,
    });
  }
  const calls: IdentityCalls = { ids: [], names: [] };
  const shell = new Shell({
    fileSystem,
    commands: defaultShellCommands,
    identityResolver: testIdentityResolver(calls),
  });
  await expect(
    shell.executeText({ credentials: USER, script: "ls -l /home" }),
  ).resolves.toMatchObject({ exitCode: 0, stderr: "" });
  expect(calls.ids).toEqual([{ uids: [USER.uid, OTHER.uid], gids: [USER.gid, OTHER.gid] }]);

  calls.ids.length = 0;
  await expect(
    shell.executeText({
      credentials: USER,
      script: "stat -c '%U:%G' /home/f000 /home/f001",
    }),
  ).resolves.toMatchObject({
    exitCode: 0,
    stdout: "alice:staff\nbob:guests\n",
    stderr: "",
  });
  expect(calls.ids).toEqual([{ uids: [USER.uid, OTHER.uid], gids: [USER.gid, OTHER.gid] }]);

  calls.ids.length = 0;
  await expect(
    shell.executeText({ credentials: USER, script: "ls -n /home" }),
  ).resolves.toMatchObject({ exitCode: 0, stderr: "" });
  expect(calls.ids).toEqual([]);

  await expect(
    shell.executeText({ credentials: USER, script: "id -u; id -g; id -G" }),
  ).resolves.toMatchObject({
    exitCode: 0,
    stdout: "1000\n10\n10 20\n",
    stderr: "",
  });
  expect(calls.ids).toEqual([]);

  await expect(
    shell.executeText({
      credentials: USER,
      script: "stat -c '%U' /home/f000 | stat -c '%U' /home/f000",
    }),
  ).resolves.toMatchObject({ exitCode: 0, stdout: "alice\n", stderr: "" });
  expect(calls.ids).toEqual([{ uids: [USER.uid], gids: [] }]);
});

it("falls back to numeric names and reports an unresolved named owner without mutation", async () => {
  const fileSystem = createTestFileSystem();
  prepareHome(fileSystem);
  await fileSystem.writeFile("/home/file", "x");
  fileSystem.setOwnership("/home/file", { uid: USER.uid, gid: USER.gid });
  await fileSystem.writeFile("/unmapped", "x");
  const calls: IdentityCalls = { ids: [], names: [] };
  const shell = new Shell({
    fileSystem,
    commands: defaultShellCommands,
    identityResolver: testIdentityResolver(calls),
  });

  await expect(
    shell.executeText({
      credentials: USER,
      script: "stat -c '%U:%G' /home/file; stat -c '%U:%G' /unmapped; chown nobody /home/file",
    }),
  ).resolves.toEqual({
    exitCode: 1,
    stdout: "alice:staff\n0:0\n",
    stderr: "chown: unknown user: nobody\n",
  });
  expect(fileSystem.stat("/home/file")).toMatchObject({ uid: USER.uid, gid: USER.gid });
});

it("rejects unsafe host names and requires a resolver for named chown", async () => {
  const fileSystem = createTestFileSystem();
  prepareHome(fileSystem);
  await fileSystem.writeFile("/home/file", "x");
  fileSystem.setOwnership("/home/file", { uid: USER.uid, gid: USER.gid });
  const withoutResolver = new Shell({ fileSystem, commands: defaultShellCommands });
  await expect(
    withoutResolver.executeText({
      credentials: USER,
      script: "chown :developers /home/file",
    }),
  ).resolves.toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining("name lookup is not available"),
  });

  const unsafeResolver: ShellIdentityResolver = {
    resolveIds: ({ uids, gids }) => ({
      users: new Map(uids.map((uid) => [uid, "alice\nroot"])),
      groups: new Map(gids.map((gid) => [gid, "staff"])),
    }),
    resolveNames: () => ({ users: new Map(), groups: new Map() }),
  };
  const shell = new Shell({
    fileSystem,
    commands: defaultShellCommands,
    identityResolver: unsafeResolver,
  });
  await expect(
    shell.executeText({
      credentials: USER,
      script: "stat -c '%U' /home/file",
    }),
  ).resolves.toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining("invalid account name"),
  });
});

it("returns utility status 1 for DAC denial while retaining status 126 for shell policy", async () => {
  const fileSystem = createTestFileSystem();
  await fileSystem.writeFile("/secret", "hidden");
  fileSystem.setMetadata("/secret", { mode: 0o100600 });
  const shell = new Shell({ fileSystem, commands: defaultShellCommands });

  await expect(shell.executeText({ script: "cat /secret", credentials: USER })).resolves.toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "/secret: permission denied\n",
  });
  await expect(
    shell.executeText({ script: "printf exposed > /secret", credentials: USER }),
  ).resolves.toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining("permission denied"),
  });

  const restricted = new Shell({
    fileSystem,
    commands: defaultShellCommands,
    policy: { readRoots: ["/allowed"] },
  });
  await expect(restricted.executeText({ script: "cat /secret" })).resolves.toMatchObject({
    exitCode: 126,
    stderr: expect.stringContaining("readable roots"),
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

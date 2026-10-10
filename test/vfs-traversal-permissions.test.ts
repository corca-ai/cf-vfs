import { expect, it } from "vitest";
import { createTestFileSystem } from "./helpers/node-sql.js";

it("checks each principal and fresh file permissions during traversal", async () => {
  const vfs = createTestFileSystem();
  await vfs.writeFile("/private/file", "body", { createParents: true });
  vfs.setOwnership("/private", { gid: 900 });
  vfs.setMetadata("/private", { mode: 0o40710 });
  const root = vfs.forCredentials({ uid: 0, gid: 0 });
  const outsider = vfs.forCredentials({ uid: 1000, gid: 1000 });
  const member = vfs.forCredentials({ uid: 1000, gid: 1000, supplementaryGids: [900] });
  root.stat("/private/file");
  expect(() => outsider.stat("/private/file")).toThrow(expect.objectContaining({ code: "EACCES" }));
  await member.readFile("/private/file").stream.cancel();
  expect(() => outsider.readFile("/private/file")).toThrow(
    expect.objectContaining({ code: "EACCES" }),
  );
  vfs.setMetadata("/private/file", { mode: 0o100000 });
  member.stat("/private/file");
  expect(() => member.readFile("/private/file")).toThrow(
    expect.objectContaining({ code: "EACCES" }),
  );
});

it("rechecks traversal after chmod, chown, replacement and symlink changes", async () => {
  const vfs = createTestFileSystem();
  await vfs.writeFile("/a/file", "body", { createParents: true });
  vfs.setOwnership("/a", { uid: 1000, gid: 1000 });
  vfs.setMetadata("/a", { mode: 0o40700 });
  const user = vfs.forCredentials({ uid: 1000, gid: 1000 });
  await user.readFile("/a/file").stream.cancel();
  vfs.setMetadata("/a", { mode: 0o40000 });
  expect(() => user.stat("/a/file")).toThrow(expect.objectContaining({ code: "EACCES" }));
  vfs.setMetadata("/a", { mode: 0o40700 });
  user.stat("/a/file");
  vfs.setOwnership("/a", { uid: 900, gid: 900 });
  expect(() => user.readFile("/a/file")).toThrow(expect.objectContaining({ code: "EACCES" }));
  vfs.setOwnership("/a", { uid: 1000, gid: 1000 });
  user.stat("/a/file");
  vfs.move("/a", "/b");
  vfs.touch("/a");
  expect(() => user.stat("/a/file")).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
  await vfs.remove("/a");
  vfs.symlink("/a", "/b");
  await user.readFile("/a/file").stream.cancel();
  vfs.setMetadata("/b", { mode: 0o40000 });
  expect(() => user.readFile("/a/file")).toThrow(expect.objectContaining({ code: "EACCES" }));
});

it("preserves missing-ancestor error precedence after another principal warmed parents", async () => {
  const vfs = createTestFileSystem();
  await vfs.writeFile("/private/file", "body", { createParents: true });
  vfs.setMetadata("/private", { mode: 0o40000 });
  vfs.forCredentials({ uid: 0, gid: 0 }).stat("/private/file");
  const user = vfs.forCredentials({ uid: 1000, gid: 1000 });
  expect(() => user.stat("/private/missing/file")).toThrow(
    expect.objectContaining({ code: "ENOENT" }),
  );
  expect(() => user.stat("/private/missing")).toThrow(expect.objectContaining({ code: "EACCES" }));
});

it("avoids a second ancestor query on repeated credential-bound reads", async () => {
  let statements = 0;
  const vfs = createTestFileSystem({ onStatement: () => statements++ });
  await vfs.writeFile("/a/b/file", "body", { createParents: true });
  const user = vfs.forCredentials({ uid: 1000, gid: 1000 });
  await user.readFile("/a/b/file").stream.cancel();
  statements = 0;
  await user.readFile("/a/b/file").stream.cancel();
  expect(statements).toBe(2);
  vfs.setMetadata("/a", { mode: 0o40000 });
  expect(() => user.readFile("/a/b/file")).toThrow(expect.objectContaining({ code: "EACCES" }));
});

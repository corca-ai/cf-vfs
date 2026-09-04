import { expect, it } from "vitest";
import type { VirtualFileSystem } from "../src/vfs/types.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

function mutate(fs: VirtualFileSystem, operation: string, token: string): void {
  const guard = { ifMutationToken: token };
  if (operation === "mode") fs.setMetadata("/link", { ...guard, mode: 0o600 });
  else if (operation === "owner") fs.setOwnership("/link", { ...guard, uid: 1000 });
  else fs.touch("/link", { ...guard, modifiedAtMs: 1234 });
}

it.each(["mode", "owner", "time", "create"])(
  "accepts a current link-chain guard for %s and rejects a repointed link",
  async (operation) => {
    const fs = createTestFileSystem();
    if (operation !== "create") {
      await fs.writeFile("/a", "a");
      await fs.writeFile("/b", "b");
    }
    fs.symlink("/link", "/a");
    const token = fs.getMutationToken("/link");
    expect(() => mutate(fs, operation, token)).not.toThrow();
    const stale = fs.getMutationToken("/link");
    fs.symlink("/link", "/b", { replace: true });
    expect(() => mutate(fs, operation, stale)).toThrowError(
      expect.objectContaining({ code: "EREVISION" }),
    );
    expect(() => mutate(fs, operation, fs.getMutationToken("/link"))).not.toThrow();
  },
);

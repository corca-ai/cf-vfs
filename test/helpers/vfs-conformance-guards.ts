import { expect } from "vitest";
import { conformanceCase, refusal, type VfsConformanceCase } from "./vfs-conformance-support.js";

export const GUARD_CONFORMANCE: readonly VfsConformanceCase[] = [
  conformanceCase("conforms: guards metadata through a symlink chain", async (factory) => {
    const fs = await factory();
    await fs.symlink("/link", "/hop");
    await fs.symlink("/hop", "/target");
    await fs.touch("/link", { ifMutationToken: await fs.getMutationToken("/link") });
    await fs.setMetadata("/link", {
      mode: 0o600,
      ifMutationToken: await fs.getMutationToken("/link"),
    });
    await fs.setOwnership("/link", {
      uid: 1000,
      ifMutationToken: await fs.getMutationToken("/link"),
    });
    expect(await fs.stat("/target")).toMatchObject({ mode: 0o600, uid: 1000 });
    const stale = { ifMutationToken: await fs.getMutationToken("/link") };
    await fs.symlink("/hop", "/elsewhere", { replace: true });
    expect(await refusal(async () => fs.touch("/link", stale))).toMatchObject({
      code: "EREVISION",
    });
  }),
];

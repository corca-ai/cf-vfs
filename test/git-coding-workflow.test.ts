import { expect, it } from "vitest";
import { RECOVERY_OPERATIONS, runGitRecovery } from "../demo/benchmark-git-recovery.js";
import { GitCodingWorkflow, WORKFLOW_OPERATIONS } from "../demo/benchmark-git-workflow.js";
import { verifyGitQuotaRecovery } from "./helpers/git-quota-recovery.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

it.each([false, true])("runs connected coding sessions with mixed=%s", async (mixed) => {
  const workflow = new GitCodingWorkflow(createTestFileSystem(), mixed);
  for (const operation of WORKFLOW_OPERATIONS) {
    await workflow.run(operation, 100);
    if (["clone", "commit-partial", "checkout-base", "checkout-main"].includes(operation))
      expect(await workflow.validate(operation, 100)).toBeGreaterThan(0);
  }
});
it.each(RECOVERY_OPERATIONS)(
  "recovers from %s with valid index/history/blob bytes",
  async (operation) => {
    expect((await runGitRecovery(createTestFileSystem(), operation)).verified).toBe(
      operation === "checkout-failure" ? 100 : operation === "partial-add-retry" ? 260 : 36,
    );
  },
);

it("recovers after real backend quota exhaustion", async () => {
  let maximum = 32 * 1024 * 1024;
  const vfs = createTestFileSystem({ maxInlineLogicalBytes: () => maximum });
  expect(
    await verifyGitQuotaRecovery(vfs, (bytes) => {
      maximum = bytes;
    }),
  ).toBe(33);
});

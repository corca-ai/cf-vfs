import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { RECOVERY_OPERATIONS, runGitRecovery } from "../demo/benchmark-git-recovery.js";
import { GitCodingWorkflow, WORKFLOW_OPERATIONS } from "../demo/benchmark-git-workflow.js";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { verifyGitQuotaRecovery } from "./helpers/git-quota-recovery.js";

it.each([false, true])("runs coding session on workerd with mixed=%s", async (mixed) => {
  const count = await runInDurableObject(
    env.VFS_TEST.getByName(`coding-${mixed}`),
    async (_instance, state) => {
      const workflow = new GitCodingWorkflow(new DurableObjectFileSystem(state.storage), mixed);
      let verified = 0;
      for (const operation of WORKFLOW_OPERATIONS) {
        await workflow.run(operation, 100);
        if (["clone", "commit-partial", "checkout-base", "checkout-main"].includes(operation))
          verified += await workflow.validate(operation, 100);
      }
      return verified;
    },
  );
  expect(count).toBe(305);
});
it.each(RECOVERY_OPERATIONS)("recovers from %s on workerd", async (operation) => {
  const outcome = await runInDurableObject(
    env.VFS_TEST.getByName(`recovery-${operation}`),
    async (_instance, state) =>
      runGitRecovery(new DurableObjectFileSystem(state.storage), operation),
  );
  expect(outcome.verified).toBe(
    operation === "checkout-failure" ? 100 : operation === "partial-add-retry" ? 260 : 36,
  );
});

it("recovers after real SQLite VFS quota exhaustion on workerd", async () => {
  const count = await runInDurableObject(
    env.VFS_TEST.getByName("coding-real-quota"),
    async (_instance, state) => {
      let maximum = 32 * 1024 * 1024;
      const vfs = new DurableObjectFileSystem(state.storage, {
        maxInlineLogicalBytes: () => maximum,
      });
      return verifyGitQuotaRecovery(vfs, (bytes) => {
        maximum = bytes;
      });
    },
  );
  expect(count).toBe(33);
});

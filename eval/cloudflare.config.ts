import { bindings, defineConfig, exports } from "cf/config";

/**
 * Deployment configuration for `cf deploy`.
 *
 * `wrangler.jsonc` beside it describes the same Worker for the Workers Vitest
 * pool and `wrangler types`, which do not read this file. Change both together.
 */
export default defineConfig({
  accountId: "b23e9b2e3a9159dd7eb3fa51f839c5c5",
  worker: {
    name: "cf-vfs-agent-eval",
    compatibilityDate: "2026-07-19",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "worker.ts",
    workersDev: false,
    observability: {
      enabled: true,
      logs: {
        enabled: true,
        headSamplingRate: 1,
      },
    },
    domains: ["eval.vfs.borca.ai"],
    env: {
      // Registered instances, including ones still being created or deleted.
      AGENT_EVAL_MAX_INSTANCES: bindings.text("20"),
      AGENT_EVAL_TOKEN: bindings.secret(),
      EVAL_REGISTRY: bindings.durableObject({
        worker: "cf-vfs-agent-eval",
        exportName: "EvalRegistry",
      }),
      EVAL_WORKSPACES: bindings.durableObject({
        worker: "cf-vfs-agent-eval",
        exportName: "EvalWorkspace",
      }),
    },
    exports: {
      EvalRegistry: exports.durableObject({ storage: "sqlite" }),
      EvalWorkspace: exports.durableObject({ storage: "sqlite" }),
    },
  },
});

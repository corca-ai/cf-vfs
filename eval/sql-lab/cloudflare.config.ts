import { bindings, defineConfig, exports } from "cf/config";

/**
 * Deployment of the SQL lab Worker with `cf`; see worker.ts. Its own Worker
 * and namespace, so arbitrary SQL never reaches evaluation workspaces or the
 * public benchmark.
 */
export default defineConfig({
  accountId: "b23e9b2e3a9159dd7eb3fa51f839c5c5",
  worker: {
    name: "cf-vfs-sql-lab",
    compatibilityDate: "2026-07-19",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "worker.ts",
    workersDev: false,
    observability: { enabled: true, logs: { enabled: true, headSamplingRate: 1 } },
    domains: ["lab.vfs.borca.ai"],
    env: {
      LAB_TOKEN: bindings.secret(),
      SQL_LAB: bindings.durableObject({ worker: "cf-vfs-sql-lab", exportName: "SqlLab" }),
    },
    exports: {
      SqlLab: exports.durableObject({ storage: "sqlite" }),
    },
  },
});

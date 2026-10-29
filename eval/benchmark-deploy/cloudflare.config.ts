import { bindings, defineConfig, exports } from "cf/config";

/**
 * Deployment of the public benchmark Worker (`vfs.borca.ai`) with `cf`.
 *
 * `wrangler.benchmark.jsonc` at the repository root still describes the same
 * Worker for the benchmark fingerprint and local tooling; change both together.
 * The Durable Object classes were created by its legacy `migrations`; they are
 * declared here as `exports`, which keeps their namespaces and data. Once
 * deployed this way the Worker cannot return to the `migrations` array.
 */
export default defineConfig({
  accountId: "b23e9b2e3a9159dd7eb3fa51f839c5c5",
  worker: {
    name: "cf-vfs-benchmark",
    compatibilityDate: "2026-07-24",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "../../bench/remote-worker.ts",
    workersDev: false,
    observability: {
      enabled: true,
      logs: { enabled: true, headSamplingRate: 1 },
      traces: { enabled: true, headSamplingRate: 0.01 },
    },
    assets: { runWorkerFirst: true },
    domains: ["vfs.borca.ai"],
    env: {
      BENCHMARK_TOKEN: bindings.secret(),
      PUBLIC_BENCHMARK_TOKEN: bindings.secret(),
      BENCHMARK_BUCKET: bindings.r2({ name: "cf-vfs-benchmark" }),
      BENCHMARK_RUNNER: bindings.worker({
        worker: "cf-vfs-benchmark",
        exportName: "BenchmarkRunner",
      }),
      PUBLIC_BENCHMARKS: bindings.durableObject({
        worker: "cf-vfs-benchmark",
        exportName: "PublicBenchmarks",
      }),
      BENCHMARK_WORKSPACES: bindings.durableObject({
        worker: "cf-vfs-benchmark",
        exportName: "BenchmarkWorkspace",
      }),
      BENCHMARK: bindings.durableObject({ worker: "cf-vfs-benchmark", exportName: "VfsBenchmark" }),
      DEMO_WORKSPACES: bindings.durableObject({
        worker: "cf-vfs-benchmark",
        exportName: "DemoWorkspace",
      }),
      VERSION_METADATA: bindings.versionMetadata(),
      ASSETS: bindings.assets(),
    },
    // Every class was introduced through `new_sqlite_classes` (migrations v1–v4).
    exports: {
      VfsBenchmark: exports.durableObject({ storage: "sqlite" }),
      DemoWorkspace: exports.durableObject({ storage: "sqlite" }),
      PublicBenchmarks: exports.durableObject({ storage: "sqlite" }),
      BenchmarkWorkspace: exports.durableObject({ storage: "sqlite" }),
    },
  },
});

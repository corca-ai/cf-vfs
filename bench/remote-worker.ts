import { DurableObject } from "cloudflare:workers";
import {
  RemoteBenchmarkHarness,
  runRemoteBenchmark,
  type RemoteBenchmarkProfile,
  type RemoteBenchmarkResult,
} from "./remote-suite.js";

interface BenchmarkResponse extends RemoteBenchmarkResult {
  edge: {
    colo: string | null;
    rpcMs: number;
  };
}

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

interface TimingSafeSubtleCrypto {
  timingSafeEqual(
    left: ArrayBuffer | ArrayBufferView,
    right: ArrayBuffer | ArrayBufferView,
  ): boolean;
}

function supportsTimingSafeEqual(
  subtle: SubtleCrypto,
): subtle is SubtleCrypto & TimingSafeSubtleCrypto {
  return "timingSafeEqual" in subtle && typeof subtle.timingSafeEqual === "function";
}

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [name, headerValue] of Object.entries(JSON_HEADERS)) {
    headers.set(name, headerValue);
  }
  return new Response(JSON.stringify(value), { ...init, headers });
}

async function authorized(request: Request, expected: string): Promise<boolean> {
  const authorization = request.headers.get("Authorization") ?? "";
  const provided = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  if (!supportsTimingSafeEqual(crypto.subtle)) {
    throw new Error("timing-safe secret comparison is unavailable");
  }
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function profileFrom(url: URL): RemoteBenchmarkProfile | null {
  const value = url.searchParams.get("profile") ?? "quick";
  return value === "quick" || value === "full" ? value : null;
}

export class VfsBenchmark extends DurableObject<VfsBenchmarkEnv> {
  private readonly benchmark = new RemoteBenchmarkHarness(this.ctx.storage);

  ping(): void {
    this.benchmark.ping();
  }

  preparePoint() {
    return this.benchmark.preparePoint();
  }

  statBatch(iterations: number) {
    return this.benchmark.statBatch(iterations);
  }

  overwriteBatch(iterations: number) {
    return this.benchmark.overwriteBatch(iterations);
  }

  findPageBatch(iterations: number) {
    return this.benchmark.findPageBatch(iterations);
  }

  warmInitializeBatch(iterations: number) {
    return this.benchmark.warmInitializeBatch(iterations);
  }

  prepareAppend(path: string, bytes: number) {
    return this.benchmark.prepareAppend(path, bytes);
  }

  append(path: string) {
    return this.benchmark.append(path);
  }

  appendCost(label: "1MiB" | "8MiB", bytes: number) {
    return this.benchmark.appendCost(label, bytes);
  }

  prepareSubtree(label: "100" | "1000", files: number) {
    return this.benchmark.prepareSubtree(label, files);
  }

  copySubtree(label: "100" | "1000") {
    return this.benchmark.copySubtree(label);
  }

  moveSubtree(label: "100" | "1000") {
    return this.benchmark.moveSubtree(label);
  }

  removeSubtree(label: "100" | "1000") {
    return this.benchmark.removeSubtree(label);
  }

  subtreeStatements(label: "100" | "1000", files: number) {
    return this.benchmark.subtreeStatements(label, files);
  }

  databaseSize() {
    return this.benchmark.databaseSize();
  }

  cleanup() {
    return this.benchmark.cleanup();
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === "GET"
      && (url.pathname === "/" || url.pathname === "/health")
    ) {
      return json({
        ok: true,
        service: "cf-vfs-benchmark",
        benchmarkAuthentication: "bearer",
      });
    }
    if (url.pathname !== "/benchmark") {
      return json({ error: "Not found" }, { status: 404 });
    }
    if (request.method !== "POST") {
      return json(
        { error: "Method not allowed" },
        { status: 405, headers: { Allow: "POST" } },
      );
    }
    if (!(await authorized(request, env.BENCHMARK_TOKEN))) {
      return json(
        { error: "Unauthorized" },
        { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
      );
    }
    const profile = profileFrom(url);
    if (profile === null) {
      return json(
        { error: "profile must be quick or full" },
        { status: 400 },
      );
    }

    const started = performance.now();
    const stub = env.BENCHMARK.get(env.BENCHMARK.newUniqueId());
    try {
      const result = await runRemoteBenchmark(stub, profile);
      await stub.cleanup();
      const response: BenchmarkResponse = {
        ...result,
        edge: {
          colo: request.cf?.colo ?? null,
          rpcMs: Number((performance.now() - started).toFixed(6)),
        },
      };
      console.log(JSON.stringify({
        message: "benchmark completed",
        profile,
        colo: response.edge.colo,
        rpcMs: response.edge.rpcMs,
      }));
      return json(response);
    } catch (error) {
      try {
        await stub.cleanup();
      } catch (cleanupError) {
        console.error(JSON.stringify({
          message: "benchmark cleanup failed",
          error: cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
        }));
      }
      console.error(JSON.stringify({
        message: "benchmark failed",
        profile,
        error: error instanceof Error ? error.message : String(error),
      }));
      return json({ error: "Benchmark failed" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<VfsBenchmarkEnv>;

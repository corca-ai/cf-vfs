import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";
import { BENCHMARK_BUILD_ID } from "../../demo/benchmark-build.js";
import { createBenchmarkFixture } from "../../demo/benchmark-fixture.js";
import { benchmarkGroups, needsValidation } from "../../demo/benchmark-protocol.js";
import { createBenchmarkFixture as createReference } from "../../demo/benchmark-reference/runtime.js";
import { meterSqlStorage } from "../metered-sql.js";
import publicWorker from "../remote-worker.js";

export {
  BenchmarkRunner,
  BenchmarkWorkspace,
  DemoWorkspace,
  PublicBenchmarks,
  VfsBenchmark,
} from "../remote-worker.js";

/** Untimed full-suite native cost audit, separate from both timing coordinators. */
export class CostWorkspace extends DurableObject<TaskEvaluationEnv> {
  private work: Promise<unknown> = Promise.resolve();
  measure(index: number, reference: boolean, build: string) {
    const run = this.work.then(async () => {
      if (build !== BENCHMARK_BUILD_ID) throw new Error("Cost evaluator build changed");
      const stages = benchmarkGroups()[index];
      if (!stages) throw new Error("Invalid group");
      await this.ctx.storage.deleteAll();
      const meter = meterSqlStorage(this.ctx.storage);
      const suite = await (reference ? createReference : createBenchmarkFixture)(meter.storage);
      try {
        const rows = [];
        for (const stage of stages) {
          meter.reset();
          const outcome = await suite.run(stage);
          const costs = {
            statements: meter.statements,
            rowsRead: meter.rowsRead,
            rowsWritten: meter.rowsWritten,
          };
          const verifiedBodies = needsValidation(stage) ? await suite.validate(stage) : 0;
          rows.push({ stage, outcome, costs, verifiedBodies });
        }
        return { rows, build: BENCHMARK_BUILD_ID };
      } finally {
        await this.ctx.storage.deleteAll();
      }
    });
    this.work = run.catch(() => undefined);
    return run;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!["/costs", "/repeat"].includes(url.pathname)) return publicWorker.fetch(request, env);
    const supplied = new TextEncoder().encode(request.headers.get("Authorization") ?? "");
    const expected = new TextEncoder().encode(`Bearer ${env.PUBLIC_BENCHMARK_TOKEN}`);
    if (
      request.method !== "POST" ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return new Response("Unauthorized", { status: 401 });
    const index = Number(url.searchParams.get("group"));
    if (!Number.isInteger(index) || index < 0 || index >= benchmarkGroups().length)
      return new Response("Invalid group", { status: 400 });
    if (url.pathname === "/repeat") {
      const pair = Number(url.searchParams.get("pair"));
      if (!Number.isInteger(pair) || pair < -1 || pair >= 10)
        return new Response("Invalid pair", { status: 400 });
      const start = index + benchmarkGroups().length * (pair < 0 ? 0 : (pair % 6) + 1);
      return Response.json(
        {
          build: BENCHMARK_BUILD_ID,
          group: await env.BENCHMARK_RUNNER.group(crypto.randomUUID(), start, 0),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const stub = env.COST_WORKSPACES.getByName("native-costs-v1", { locationHint: "wnam" });
    const reference = await stub.measure(index, true, BENCHMARK_BUILD_ID);
    const candidate = await stub.measure(index, false, BENCHMARK_BUILD_ID);
    return Response.json(
      { reference, candidate, groups: benchmarkGroups().length },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
} satisfies ExportedHandler<TaskEvaluationEnv>;

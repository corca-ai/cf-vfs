import { DurableObject } from "cloudflare:workers";
import { BENCHMARK_BUILD_ID } from "./benchmark-build.js";
import { createBenchmarkFixture } from "./benchmark-fixture.js";
import type { BenchmarkArm } from "./benchmark-protocol.js";
import { createBenchmarkFixture as createReferenceFixture } from "./benchmark-reference/runtime.js";
import type { BenchmarkStage, PublicBenchmarkSuite } from "./benchmark-suite.js";

/** Scratch-only DO: polling and result storage never enter its measured RPCs. */
export class BenchmarkWorkspace extends DurableObject<VfsBenchmarkEnv> {
  private suite: PublicBenchmarkSuite | undefined;
  private token: string | undefined;
  private work: Promise<unknown> = Promise.resolve();
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.work.then(operation);
    this.work = result.catch(() => undefined);
    return result;
  }

  prepare(token: string, arm: BenchmarkArm, expectedBuild: string) {
    return this.exclusive(async () => {
      if (expectedBuild !== BENCHMARK_BUILD_ID) throw new Error("Benchmark deployment changed");
      this.suite = undefined;
      this.token = undefined;
      await this.ctx.storage.deleteAll();
      this.suite = await (arm === "reference" ? createReferenceFixture : createBenchmarkFixture)(
        this.ctx.storage,
      );
      this.token = token;
      return BENCHMARK_BUILD_ID;
    });
  }
  ping(token: string) {
    this.active(token);
    return BENCHMARK_BUILD_ID;
  }
  private active(token: string) {
    if (this.token !== token || !this.suite) throw new Error("Scratch fixture was interrupted");
    return this.suite;
  }
  stage(token: string, stage: BenchmarkStage) {
    return this.exclusive(async () => {
      const result = await this.active(token).run(stage);
      return { ...result, buildId: BENCHMARK_BUILD_ID };
    });
  }
  validate(token: string, stage: BenchmarkStage) {
    return this.exclusive(() => this.active(token).validate(stage));
  }
  clear(token: string) {
    return this.exclusive(async () => {
      this.active(token);
      this.suite = undefined;
      this.token = undefined;
      await this.ctx.storage.deleteAll();
    });
  }
}

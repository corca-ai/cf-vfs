import { DurableObject } from "cloudflare:workers";
import { meterSqlStorage, type SqlMeter } from "../bench/metered-sql.js";
import type { AgentTask } from "./benchmark-agent-task.js";
import { BENCHMARK_BUILD_ID } from "./benchmark-build.js";
import { createBenchmarkFixture } from "./benchmark-fixture.js";
import type { BenchmarkArm } from "./benchmark-protocol.js";
import { createBenchmarkFixture as createReferenceFixture } from "./benchmark-reference/runtime.js";
import type { BenchmarkStage, PublicBenchmarkSuite } from "./benchmark-suite.js";
import { createTaskFixture } from "./benchmark-task-fixture.js";
import { createTaskFixture as createReferenceTask } from "./benchmark-task-reference/runtime.js";

/** Scratch-only DO: polling and result storage never enter its measured RPCs. */
export class BenchmarkWorkspace extends DurableObject<VfsBenchmarkEnv> {
  private suite: PublicBenchmarkSuite | undefined;
  private token: string | undefined;
  private task: AgentTask | undefined;
  private meter: SqlMeter | undefined;
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
      this.task = undefined;
      this.meter = undefined;
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
    if (this.token !== token || (!this.suite && !this.task)) throw new Error("Inactive fixture");
    return BENCHMARK_BUILD_ID;
  }
  prepareTask(token: string, arm: BenchmarkArm, expectedBuild: string, profile = false) {
    return this.exclusive(async () => {
      if (expectedBuild !== BENCHMARK_BUILD_ID) throw new Error("Benchmark deployment changed");
      this.task = undefined;
      this.suite = undefined;
      this.token = undefined;
      await this.ctx.storage.deleteAll();
      this.meter = profile ? meterSqlStorage(this.ctx.storage) : undefined;
      this.task = await (arm === "reference" ? createReferenceTask : createTaskFixture)(
        this.meter?.storage ?? this.ctx.storage,
      );
      this.meter?.reset();
      this.token = token;
      return BENCHMARK_BUILD_ID;
    });
  }
  taskCycle(token: string) {
    return this.exclusive(async () => {
      if (this.token !== token || !this.task) throw new Error("Inactive task");
      const outputs = await this.task.cycle();
      const meter = this.meter;
      return {
        outputs,
        buildId: BENCHMARK_BUILD_ID,
        costs: meter
          ? {
              statements: meter.statements,
              rowsRead: meter.rowsRead,
              rowsWritten: meter.rowsWritten,
            }
          : null,
      };
    });
  }
  validateTask(token: string) {
    return this.exclusive(() => {
      if (this.token !== token || !this.task) throw new Error("Inactive task");
      return this.task.validate();
    });
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
      if (this.token !== token) throw new Error("Scratch fixture was interrupted");
      this.suite = undefined;
      this.task = undefined;
      this.meter = undefined;
      this.token = undefined;
      await this.ctx.storage.deleteAll();
    });
  }
}

import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";
import type { ExecuteTextResult } from "../../src/shell/types.js";
import { meterSqlStorage } from "../metered-sql.js";
import { PublicBenchmarkSuite as BeforeSuite } from "../three-hour-2026-10-10/compiled/bash-baseline/demo/benchmark-suite.js";
import { defaultShellCommands as beforeCommands } from "../three-hour-2026-10-10/compiled/bash-baseline/src/shell/commands/default.js";
import { Shell as BeforeShell } from "../three-hour-2026-10-10/compiled/bash-baseline/src/shell/shell.js";
import { DurableObjectFileSystem as BeforeFs } from "../three-hour-2026-10-10/compiled/bash-baseline/src/vfs/do-sql.js";
import {
  benchmarkPlan,
  PublicBenchmarkSuite,
} from "../three-hour-2026-10-10/compiled/bash-candidate/demo/benchmark-suite.js";
import { defaultShellCommands } from "../three-hour-2026-10-10/compiled/bash-candidate/src/shell/commands/default.js";
import { Shell } from "../three-hour-2026-10-10/compiled/bash-candidate/src/shell/shell.js";
import { DurableObjectFileSystem } from "../three-hour-2026-10-10/compiled/bash-candidate/src/vfs/do-sql.js";
import { scenarios } from "./scenarios.js";

const BUILD = "bash-e1d5e34f4825b460";
const plan = benchmarkPlan().filter((stage) => stage.trial === 0);
export class BashEvaluation extends DurableObject<BashEvaluationEnv> {
  private suite: PublicBenchmarkSuite | BeforeSuite | undefined;
  private readonly meter = meterSqlStorage(this.ctx.storage);
  async setup(version: string, credentials: string) {
    await this.clear();
    let suite: PublicBenchmarkSuite | BeforeSuite;
    const raw = new (version === "baseline" ? BeforeFs : DurableObjectFileSystem)(
      this.meter.storage,
      {
        maxEntries: 20000,
        maxInlineLogicalBytes: 32 * 1024 * 1024,
        onEvent: (event) => suite?.onEvent(event),
      },
    );
    await raw.initialize();
    if (credentials === "demo") raw.setMetadata("/", { mode: 0o40777 });
    const fs = credentials === "demo" ? raw.forCredentials({ uid: 1000, gid: 1000 }) : raw;
    suite = new (version === "baseline" ? BeforeSuite : PublicBenchmarkSuite)(fs, 1700000000000);
    this.suite = suite;
  }
  async stage(index: number) {
    const stage = plan[index];
    if (!this.suite || !stage) throw new Error("Missing setup or stage");
    this.meter.reset();
    const result = await this.suite.run(stage);
    return {
      ...result,
      sql: {
        statements: this.meter.statements,
        rowsRead: this.meter.rowsRead,
        rowsWritten: this.meter.rowsWritten,
      },
    };
  }
  async validate(index: number) {
    const stage = plan[index];
    if (!this.suite || !stage) throw new Error("Missing setup or stage");
    return this.suite.validate(stage);
  }
  async shell(version: string, index: number) {
    const scenario = scenarios[index];
    if (!scenario) throw new Error("Unknown scenario");
    const before = version === "baseline";
    const fs = new (before ? BeforeFs : DurableObjectFileSystem)(this.ctx.storage);
    const shell = new (before ? BeforeShell : Shell)({
      fileSystem: fs,
      commands: before ? beforeCommands : defaultShellCommands,
    });
    for (let repeat = 0; repeat < 20; repeat++) {
      const result: ExecuteTextResult = await shell.executeText({ script: scenario.script });
      if (result.exitCode !== 0 || result.stderr !== "" || result.stdout !== scenario.stdout)
        throw new Error(`Shell output changed: ${JSON.stringify(result)}`);
    }
    return { verified: 20, name: scenario.name };
  }
  async clear() {
    this.suite = undefined;
    await this.ctx.storage.deleteAll();
  }
}
export default {
  async fetch(request, env): Promise<Response> {
    const supplied = new TextEncoder().encode(request.headers.get("Authorization") ?? "");
    const expected = new TextEncoder().encode(`Bearer ${env.EVALUATION_TOKEN}`);
    if (
      request.method !== "POST" ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return new Response("Unauthorized", { status: 401 });
    const url = new URL(request.url);
    const room = url.searchParams.get("room") ?? "";
    if (!/^full-[a-z0-9-]{1,100}$/u.test(room))
      return new Response("Invalid room", { status: 400 });
    const version = url.searchParams.get("version");
    if (version !== "baseline" && version !== "candidate")
      return new Response("Invalid version", { status: 400 });
    const stub = env.EVALUATIONS.getByName(room, { locationHint: "wnam" });
    const credentials = url.searchParams.get("credentials") === "demo" ? "demo" : "none";
    try {
      let value: object;
      if (url.pathname === "/setup") {
        await stub.setup(version, credentials);
        value = { ok: true };
      } else if (url.pathname === "/clear") {
        await stub.clear();
        value = { ok: true };
      } else if (url.pathname === "/shell") {
        const start = performance.now();
        value = {
          ...(await stub.shell(version, Number(url.searchParams.get("index")))),
          ms: performance.now() - start,
        };
      } else if (url.pathname === "/group") {
        const start = Number(url.searchParams.get("start"));
        const initial = plan[start];
        if (!Number.isSafeInteger(start) || !initial)
          return new Response("Invalid stage", { status: 400 });
        const rows = [];
        let index = start;
        for (; index < plan.length; index++) {
          const stage = plan[index];
          if (
            !stage ||
            stage.group !== initial.group ||
            stage.files !== initial.files ||
            stage.cache !== initial.cache
          )
            break;
          const began = performance.now();
          const result = await stub.stage(index);
          const ms = performance.now() - began;
          const needsValidation =
            (["coding-small", "coding-mixed"].includes(stage.group) &&
              ["clone", "commit-partial", "checkout-base", "checkout-main"].includes(
                stage.operation,
              )) ||
            stage.operation === "remove-tree" ||
            stage.operation === "checkout-main" ||
            (stage.group === "git-shell" &&
              ["add-one", "add-changed", "add-removals"].includes(stage.operation));
          const verifiedBodies = needsValidation ? await stub.validate(index) : 0;
          rows.push({ stage, version, ms, ...result, verifiedBodies });
        }
        value = { rows, nextIndex: index, done: index === plan.length };
      } else return new Response("Not found", { status: 404 });
      return Response.json({ ...value, build: BUILD, colo: request.cf?.colo });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<BashEvaluationEnv>;

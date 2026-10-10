import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";
import {
  type BenchmarkStage,
  benchmarkPlan,
  PublicBenchmarkSuite,
} from "../../demo/benchmark-suite.js";
import { defineApplet } from "../../src/shell/commands/applet.js";
import { collectStream } from "../../src/shell/commands/helpers.js";
import { Shell } from "../../src/shell/shell.js";
import { DurableObjectFileSystem } from "../../src/vfs/do-sql.js";
import { meterSqlStorage } from "../metered-sql.js";
import { PublicBenchmarkSuite as BaselineSuite } from "./compiled/baseline-fixed/demo/benchmark-suite.js";
import { collectStream as baselineCollectStream } from "./compiled/baseline-fixed/src/shell/commands/helpers.js";
import { Shell as BaselineShell } from "./compiled/baseline-fixed/src/shell/shell.js";
import { DurableObjectFileSystem as BaselineFileSystem } from "./compiled/baseline-fixed/src/vfs/do-sql.js";

const BUILD = "traversal-cache-v2-1d3d16785aef";
const plan = benchmarkPlan().filter((stage) => stage.trial === 0);
function validates(stage: BenchmarkStage) {
  return (
    (["coding-small", "coding-mixed"].includes(stage.group) &&
      ["clone", "commit-partial", "checkout-base", "checkout-main"].includes(stage.operation)) ||
    stage.operation === "remove-tree" ||
    stage.operation === "checkout-main" ||
    (stage.group === "git-shell" &&
      ["add-one", "add-changed", "add-removals"].includes(stage.operation))
  );
}
export class FullEvaluation extends DurableObject<FullEvaluationEnv> {
  private baseline: boolean | undefined;
  private readonly meter = meterSqlStorage(this.ctx.storage);
  private suite: PublicBenchmarkSuite | BaselineSuite | undefined;
  private async initialize() {
    if (this.suite !== undefined) return this.suite;
    this.baseline ??= (await this.ctx.storage.get<string>("evaluation-version")) === "baseline";
    const fs = new (this.baseline ? BaselineFileSystem : DurableObjectFileSystem)(
      this.ctx.id.name?.includes("-profile") ? this.meter.storage : this.ctx.storage,
      {
        maxEntries: 20_000,
        maxInlineLogicalBytes: 32 * 1024 * 1024,
        maxInFlightBufferedBytes: 16 * 1024 * 1024,
        onEvent: (event) => this.suite?.onEvent(event),
      },
    );
    await fs.initialize();
    const credentials = await this.ctx.storage.get<string>("evaluation-credentials");
    if (credentials === "demo") fs.setMetadata("/", { mode: 0o40777 });
    const view =
      credentials === "demo"
        ? fs.forCredentials({ uid: 1000, gid: 1000 })
        : credentials === "root"
          ? fs.forCredentials({ uid: 0, gid: 0 })
          : fs;
    this.suite = new (this.baseline ? BaselineSuite : PublicBenchmarkSuite)(view, 1700000000000);
    return this.suite;
  }
  async setup(version: string, credentials: string) {
    await this.ctx.storage.deleteAll();
    this.suite = undefined;
    this.baseline = version === "baseline";
    await this.ctx.storage.put("evaluation-version", version);
    await this.ctx.storage.put("evaluation-credentials", credentials);
    await this.initialize();
    return { ok: true };
  }
  async stage(index: number) {
    const stage = plan[index];
    if (stage === undefined) throw new Error("Unknown stage");
    const suite = await this.initialize();
    this.meter.reset();
    const value = await suite.run(stage);
    return {
      ...value,
      sql: {
        statements: this.meter.statements,
        rowsRead: this.meter.rowsRead,
        rowsWritten: this.meter.rowsWritten,
      },
    };
  }
  async validate(index: number) {
    const stage = plan[index];
    if (stage === undefined) throw new Error("Unknown stage");
    return (await this.initialize()).validate(stage);
  }
  async memory() {
    const baseline = (await this.ctx.storage.get<string>("evaluation-version")) === "baseline";
    const fs = new (baseline ? BaselineFileSystem : DurableObjectFileSystem)(this.ctx.storage);
    const collect = baseline ? baselineCollectStream : collectStream;
    const ShellClass = baseline ? BaselineShell : Shell;
    const rows = [];
    for (const limit of [96 * 1024, 128 * 1024]) {
      let peakReserved = 0;
      let peakAttempted = 0;
      let verified = false;
      const command = defineApplet(
        { name: "memory-probe", usage: "", summary: "private buffer probe" },
        async (context) => {
          const budget = new Proxy(context.budget, {
            get(target, property) {
              if (property === "buffered")
                return (bytes: number) => {
                  const held = limit - (target.remainingBufferedBytes?.() ?? limit);
                  peakAttempted = Math.max(peakAttempted, held + bytes);
                  const release = target.buffered(bytes);
                  peakReserved = Math.max(
                    peakReserved,
                    limit - (target.remainingBufferedBytes?.() ?? limit),
                  );
                  return release;
                };
              const value: unknown = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          const lease = await collect(
            { ...context, budget },
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(64 * 1024).fill(7));
                controller.close();
              },
            }),
          );
          verified =
            lease.value.byteLength === 64 * 1024 && lease.value.every((byte) => byte === 7);
          lease.release();
          return 0;
        },
      );
      const shell = new ShellClass({
        fileSystem: fs,
        commands: [command],
        limits: { maxBufferedBytes: limit },
      });
      const result = await shell.executeText({ script: "memory-probe" });
      rows.push({
        limit,
        peakReserved,
        peakAttempted,
        verified,
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    }
    return { rows };
  }
  async clear() {
    await this.ctx.storage.deleteAll();
    this.suite = undefined;
    return { ok: true };
  }
}
export default {
  async fetch(request, env): Promise<Response> {
    const supplied = new TextEncoder().encode(request.headers.get("Authorization") ?? "");
    const expected = new TextEncoder().encode(`Bearer ${env.EVALUATION_TOKEN}`);
    if (
      request.method !== "POST" ||
      supplied.byteLength !== expected.byteLength ||
      !timingSafeEqual(supplied, expected)
    )
      return new Response("Unauthorized", { status: 401 });
    const url = new URL(request.url);
    const room = url.searchParams.get("room") ?? "";
    if (!/^full-[a-z0-9-]{1,100}$/u.test(room))
      return new Response("Invalid room", { status: 400 });
    const only = url.searchParams.get("version");
    const versions =
      only === "baseline" || only === "candidate"
        ? [only]
        : url.searchParams.get("order") === "candidate"
          ? (["candidate", "baseline"] as const)
          : (["baseline", "candidate"] as const);
    const stub = (version: string) =>
      env.EVALUATIONS.getByName(only === null ? `${room}-${version}` : room, {
        locationHint: "wnam",
      });
    try {
      if (url.pathname === "/setup" || url.pathname === "/clear") {
        for (const version of versions)
          if (url.pathname === "/setup")
            await stub(version).setup(
              version,
              ["root", "demo"].includes(url.searchParams.get("credentials") ?? "")
                ? (url.searchParams.get("credentials") ?? "none")
                : "none",
            );
          else await stub(version).clear();
        return Response.json({ ok: true, build: BUILD, colo: request.cf?.colo });
      }
      if (url.pathname === "/memory") {
        const rows = [];
        for (const version of versions) rows.push({ version, ...(await stub(version).memory()) });
        return Response.json({ build: BUILD, colo: request.cf?.colo, rows });
      }
      if (url.pathname !== "/group") return new Response("Not found", { status: 404 });
      const start = Number(url.searchParams.get("start"));
      const initial = plan[start];
      if (!Number.isSafeInteger(start) || initial === undefined)
        return new Response("Invalid stage", { status: 400 });
      const rows = [];
      let index = start;
      for (; index < plan.length; index++) {
        const stage = plan[index];
        if (
          stage === undefined ||
          stage.group !== initial.group ||
          stage.files !== initial.files ||
          stage.cache !== initial.cache
        )
          break;
        for (const version of versions) {
          const target = stub(version);
          const started = performance.now();
          const value = await target.stage(index);
          const ms = performance.now() - started;
          const verified = validates(stage) ? await target.validate(index) : 0;
          rows.push({ stage, version, ms, ...value, verifiedBodies: verified });
        }
      }
      return Response.json({
        build: BUILD,
        nextIndex: index,
        done: index === plan.length,
        rows,
        colo: request.cf?.colo,
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<FullEvaluationEnv>;

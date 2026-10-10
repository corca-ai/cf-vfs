import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";
import { meterSqlStorage } from "../metered-sql.js";
import { PublicBenchmarkSuite as BaselineSuite } from "./compiled/baseline/demo/benchmark-suite.js";
import { createFsAdapter as baselineFsAdapter } from "./compiled/baseline/src/fs/index.js";
import { collectStream as baselineCollectStream } from "./compiled/baseline/src/shell/commands/helpers.js";
import { Shell as BaselineShell } from "./compiled/baseline/src/shell/shell.js";
import { DurableObjectFileSystem as BaselineFileSystem } from "./compiled/baseline/src/vfs/do-sql.js";
import {
  type BenchmarkStage,
  benchmarkPlan,
  PublicBenchmarkSuite,
} from "./compiled/candidate/demo/benchmark-suite.js";
import { createFsAdapter } from "./compiled/candidate/src/fs/index.js";
import { defineApplet } from "./compiled/candidate/src/shell/commands/applet.js";
import { collectStream } from "./compiled/candidate/src/shell/commands/helpers.js";
import { Shell } from "./compiled/candidate/src/shell/shell.js";
import { DurableObjectFileSystem } from "./compiled/candidate/src/vfs/do-sql.js";

const BUILD = "five-hour-round2-006ba6e7000d";
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
  async namespace(version: string, count: number, recordChanges: boolean, copy = false) {
    await this.clear();
    try {
      const raw = new (version === "baseline" ? BaselineFileSystem : DurableObjectFileSystem)(
        this.meter.storage,
        { recordChanges },
      );
      raw.setMetadata("/", { mode: 0o40777 });
      const fs = raw.forCredentials({ uid: 1000, gid: 1000 });
      for (let index = 0; index < count; index++)
        await fs.writeFile(`/noise/f${index}`, "noise", { createParents: true });
      await fs.writeFile("/source", "source");
      await fs.writeFile("/target", "target");
      const source = fs.stat("/source");
      const target = fs.stat("/target");
      const cursor = recordChanges ? raw.changesSince(0, { limit: 10000 }).cursor : 0;
      this.meter.reset();
      if (copy) await fs.copy("/source", "/target", { replace: true });
      else await fs.move("/source", "/target", { replace: true });
      const cost = {
        statements: this.meter.statements,
        rowsRead: this.meter.rowsRead,
        rowsWritten: this.meter.rowsWritten,
      };
      const changes = recordChanges ? raw.changesSince(cursor).changes : [];
      const after = fs.stat("/target");
      const body = await new Response(fs.readFile("/target").stream).text();
      if (
        after.ino !== (copy ? target.ino : source.ino) ||
        after.mutationToken === target.mutationToken ||
        (fs.getMutationToken("/source") === source.mutationToken) !== copy ||
        body !== "source"
      )
        throw new Error("rename identity/content/token changed");
      if (
        recordChanges &&
        JSON.stringify(changes) !==
          JSON.stringify([
            ...(copy ? [] : [{ path: "/source", present: false }]),
            { path: "/target", present: true },
            { path: "/", present: true },
          ])
      )
        throw new Error("rename feed changed");
      if (copy && (await new Response(fs.readFile("/source").stream).text()) !== "source")
        throw new Error("copy source changed");
      return { ...cost, changes, operation: copy ? "copy" : "move", verified: true };
    } finally {
      await this.clear();
    }
  }
  async handles(version: string, count: number) {
    await this.clear();
    try {
      const fs =
        version === "baseline"
          ? baselineFsAdapter(new BaselineFileSystem(this.meter.storage, { chunkBytes: 32768 }))
              .promises
          : createFsAdapter(new DurableObjectFileSystem(this.meter.storage, { chunkBytes: 32768 }))
              .promises;
      for (let index = 0; index < count; index++) await fs.writeFile(`/noise${index}`, "noise");
      await fs.writeFile("/file", new Uint8Array(1024 * 1024).fill(65));
      const handle = await fs.open("/file", "r+");
      const identity = (await handle.stat()).ino;
      const rows: {
        operation: string;
        ms: number;
        statements: number;
        rowsRead: number;
        rowsWritten: number;
      }[] = [];
      const sample = async (operation: string, run: () => Promise<unknown>) => {
        this.meter.reset();
        const started = performance.now();
        await run();
        rows.push({
          operation,
          ms: performance.now() - started,
          statements: this.meter.statements,
          rowsRead: this.meter.rowsRead,
          rowsWritten: this.meter.rowsWritten,
        });
      };
      await sample("fstat-100", async () => {
        for (let i = 0; i < 100; i++) await handle.stat();
      });
      await sample("write-byte-100", async () => {
        for (let i = 0; i < 100; i++) await handle.write("z", 0);
      });
      await sample("truncate-zero", () => handle.truncate(0));
      await fs.link("/file", "/alias");
      await fs.unlink("/file");
      await sample("alias-fstat-100", async () => {
        for (let i = 0; i < 100; i++) await handle.stat();
      });
      await handle.write("changed!", 0);
      if (
        (await handle.stat()).ino !== identity ||
        (await fs.readFile("/alias", "utf8")) !== "changed!"
      )
        throw new Error("handle alias identity/content changed");
      await fs.unlink("/alias");
      if ((await handle.stat()).nlink !== 0 || (await handle.readFile("utf8")) !== "changed!")
        throw new Error("detached handle changed");
      await handle.close();
      return { rows, verified: true };
    } finally {
      await this.clear();
    }
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
      if (url.pathname === "/namespace") {
        const count = Number(url.searchParams.get("files"));
        if (count !== 100 && count !== 1000) return new Response("Invalid count", { status: 400 });
        const recordChanges = url.searchParams.get("changes") === "1";
        const rows = [];
        for (const version of versions)
          rows.push({
            version,
            ...(await stub(version).namespace(
              version,
              count,
              recordChanges,
              url.searchParams.get("operation") === "copy",
            )),
          });
        return Response.json({ build: BUILD, colo: request.cf?.colo, count, recordChanges, rows });
      }
      if (url.pathname === "/handles") {
        const count = Number(url.searchParams.get("files"));
        if (count !== 100 && count !== 1000) return new Response("Invalid count", { status: 400 });
        const rows = [];
        for (const version of versions)
          rows.push({ version, ...(await stub(version).handles(version, count)) });
        return Response.json({ build: BUILD, colo: request.cf?.colo, count, rows });
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

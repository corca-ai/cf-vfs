import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";
import type { ExecuteTextResult } from "../../src/shell/types.js";
import { expectedFiles, files, scenarios } from "../agent-shell-round2-2026-10-11/scenarios.js";
import { meterSqlStorage } from "../metered-sql.js";
import { PublicBenchmarkSuite as BeforeSuite } from "../three-hour-2026-10-10/compiled/workspace-before/demo/benchmark-suite.js";
import { defaultShellCommands as beforeCommands } from "../three-hour-2026-10-10/compiled/workspace-before/src/shell/commands/default.js";
import { gitCommand as beforeGit } from "../three-hour-2026-10-10/compiled/workspace-before/src/shell/commands/git.js";
import { Shell as BeforeShell } from "../three-hour-2026-10-10/compiled/workspace-before/src/shell/shell.js";
import { DurableObjectFileSystem as BeforeFs } from "../three-hour-2026-10-10/compiled/workspace-before/src/vfs/do-sql.js";
import {
  benchmarkPlan,
  PublicBenchmarkSuite,
} from "../three-hour-2026-10-10/compiled/workspace-compatible/demo/benchmark-suite.js";
import { defaultShellCommands } from "../three-hour-2026-10-10/compiled/workspace-compatible/src/shell/commands/default.js";
import { gitCommand } from "../three-hour-2026-10-10/compiled/workspace-compatible/src/shell/commands/git.js";
import { Shell } from "../three-hour-2026-10-10/compiled/workspace-compatible/src/shell/shell.js";
import { DurableObjectFileSystem } from "../three-hour-2026-10-10/compiled/workspace-compatible/src/vfs/do-sql.js";

const BUILD = "workspace-flow-compatible";
const plan = benchmarkPlan().filter((stage) => stage.trial === 0);
export class CommitEvaluation extends DurableObject<CommitEvaluationEnv> {
  private suite: PublicBenchmarkSuite | BeforeSuite | undefined;
  private readonly meter = meterSqlStorage(this.ctx.storage);
  private target:
    | { fs: BeforeFs | DurableObjectFileSystem; shell: BeforeShell | Shell }
    | undefined;
  buildIdentity() {
    return BUILD;
  }
  async prepareFlow(version: string) {
    await this.clear();
    const candidate = version === "candidate";
    const fs = new (candidate ? DurableObjectFileSystem : BeforeFs)(this.meter.storage, {
      maxEntries: 20000,
    });
    await fs.initialize();
    fs.setMetadata("/", { mode: 0o40777 });
    const view = fs.forCredentials({ uid: 1000, gid: 1000 });
    view.mkdir("/repo");
    for (let i = 0; i < 1000; i++)
      await view.writeFile(
        `/repo/src/d${i % 20}/f${i}.txt`,
        `export const value = 'state0'; // ${i}\n`,
        { createParents: true },
      );
    const shell = new (candidate ? Shell : BeforeShell)({
      fileSystem: fs,
      commands: [
        ...(candidate ? defaultShellCommands : beforeCommands),
        candidate ? gitCommand : beforeGit,
      ],
      now: () => 1700000000000,
    });
    this.target = { fs, shell };
    await this.runFlow(
      "git init; git config user.name Bench; git config user.email bench@example.invalid; git add .; git commit -m initial",
    );
  }
  private async runFlow(script: string) {
    if (!this.target) throw new Error("Missing flow fixture");
    const result = await this.target.shell.executeText({
      script,
      cwd: "/repo",
      credentials: { uid: 1000, gid: 1000 },
    });
    if (result.exitCode !== 0 || result.stderr !== "") throw new Error(JSON.stringify(result));
    return result.stdout;
  }
  async flow(phase: string, pair: number) {
    const next = `state${pair + 3}`,
      prev = "state[0-9]*";
    const scripts: Record<string, string> = {
      inspect: "git status --short",
      edit: Array.from(
        { length: 20 },
        (_, i) =>
          `sed 's/${prev}/${next}/g' src/d${i}/f${i}.txt > src/d${i}/next.txt; cat src/d${i}/next.txt > src/d${i}/f${i}.txt; rm src/d${i}/next.txt`,
      ).join("; "),
      verify: Array.from({ length: 20 }, (_, i) => `grep -c ${next} src/d${i}/f${i}.txt`).join(
        "; ",
      ),
      stage: "git add .",
      commit: `git commit -m round${pair}`,
    };
    const script = scripts[phase];
    if (script === undefined) throw new Error("Unknown phase");
    this.meter.reset();
    const stdout = await this.runFlow(script);
    if (phase === "inspect" && stdout !== "") throw new Error("Dirty initial state");
    if (phase === "verify" && stdout !== "1\n".repeat(20))
      throw new Error("Invalid edited content");
    return {
      stdout,
      doBuild: BUILD,
      sql: {
        statements: this.meter.statements,
        rowsRead: this.meter.rowsRead,
        rowsWritten: this.meter.rowsWritten,
      },
    };
  }
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
  async prepareAgent() {
    await this.clear();
    const fs = new DurableObjectFileSystem(this.ctx.storage);
    await fs.initialize();
    fs.setMetadata("/", { mode: 0o40777 });
    const bound = fs.forCredentials({ uid: 1000, gid: 1000 });
    for (const [path, body] of Object.entries(files)) await bound.writeFile(path, body);
  }
  async shell(version: string, index: number) {
    const scenario = scenarios[index];
    if (!scenario) throw new Error("Unknown scenario");
    const before = version === "baseline";
    const fs = new (before ? BeforeFs : DurableObjectFileSystem)(this.meter.storage).forCredentials(
      { uid: 1000, gid: 1000 },
    );
    const shell = new (before ? BeforeShell : Shell)({
      fileSystem: fs,
      commands: before ? beforeCommands : defaultShellCommands,
    });
    this.meter.reset();
    for (let repeat = 0; repeat < 50; repeat++) {
      const result: ExecuteTextResult = await shell.executeText({ script: scenario.script });
      if (result.exitCode !== 0 || result.stderr !== "" || result.stdout !== scenario.stdout)
        throw new Error(`Shell output changed: ${JSON.stringify(result)}`);
    }
    return {
      verified: 50,
      name: scenario.name,
      sql: {
        statements: this.meter.statements,
        rowsRead: this.meter.rowsRead,
        rowsWritten: this.meter.rowsWritten,
      },
    };
  }
  async verifyAgent(index: number) {
    const scenario = scenarios[index];
    if (!scenario) throw new Error("Unknown scenario");
    const fs = new DurableObjectFileSystem(this.ctx.storage).forCredentials({
      uid: 1000,
      gid: 1000,
    });
    const bodies = { ...files, ...(expectedFiles[scenario.name] ?? {}) };
    for (const [path, body] of Object.entries(bodies)) {
      if ((await new Response(fs.readFile(path).stream).text()) !== body)
        throw new Error(`File bytes changed: ${path}`);
    }
    return { verifiedFiles: Object.keys(bodies).length };
  }
  async clear() {
    this.suite = undefined;
    this.target = undefined;
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
      if ((await stub.buildIdentity()) !== BUILD)
        throw new Error("Evaluation build is propagating");
      let value: object;
      if (url.pathname === "/prepare-flow") {
        await stub.prepareFlow(version);
        value = { ok: true };
      } else if (url.pathname === "/flow") {
        const rows = [];
        for (const phase of ["inspect", "edit", "verify", "stage", "commit"]) {
          const start = performance.now();
          const result = await stub.flow(phase, Number(url.searchParams.get("index")));
          rows.push({ phase, ms: performance.now() - start, ...result });
        }
        value = { rows };
      } else if (url.pathname === "/verify-agent") {
        value = await stub.verifyAgent(Number(url.searchParams.get("index")));
      } else if (url.pathname === "/prepare-agent") {
        await stub.prepareAgent();
        value = { ok: true };
      } else if (url.pathname === "/setup") {
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
} satisfies ExportedHandler<CommitEvaluationEnv>;

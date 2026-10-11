import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";
import { FsMetadataIndex } from "../../src/fs/metadata.js";
import { DurableObjectFileSystem } from "../../src/vfs/do-sql.js";
import { meterSqlStorage } from "../metered-sql.js";

export class CapabilityEvaluation extends DurableObject<CapabilityEnv> {
  async clear() {
    await this.ctx.storage.deleteAll();
  }
  async mutationCosts() {
    const rows = [];
    for (const recordChanges of [false, true]) {
      await this.clear();
      const meter = meterSqlStorage(this.ctx.storage);
      const fs = new DurableObjectFileSystem(meter.storage, { recordChanges });
      await fs.initialize();
      await fs.writeFile("/file", "before");
      meter.reset();
      await fs.writeFile("/file", "after");
      const cost = {
        statements: meter.statements,
        rowsRead: meter.rowsRead,
        rowsWritten: meter.rowsWritten,
      };
      const verified = (await new Response(fs.readFile("/file").stream).text()) === "after";
      rows.push({ recordChanges, verified, ...cost });
    }
    return { rows };
  }
  async evaluate(order: string) {
    await this.ctx.storage.deleteAll();
    const meter = meterSqlStorage(this.ctx.storage);
    const fs = new DurableObjectFileSystem(meter.storage, { recordChanges: true });
    await fs.initialize();
    fs.mkdir("/work");
    await fs.writeFiles(
      Array.from({ length: 1000 }, (_, i) => ({ path: `/work/f${i}`, body: "hello" })),
    );
    const paths = Array.from({ length: 1000 }, (_, i) => `/work/f${i}`);
    const index = new FsMetadataIndex(fs);
    meter.reset();
    index.refresh();
    const initialIndexCost = {
      statements: meter.statements,
      rowsRead: meter.rowsRead,
      rowsWritten: meter.rowsWritten,
    };
    await fs.writeFile("/work/f0", "changed");
    const rows = [];
    for (const credentials of [false, true]) {
      const view = credentials ? fs.forCredentials({ uid: 1000, gid: 1000 }) : fs;
      for (const version of order === "candidate"
        ? ["candidate", "baseline"]
        : ["baseline", "candidate"]) {
        meter.reset();
        const result =
          version === "baseline"
            ? paths.map((path) => ({ stat: view.lstat(path) }))
            : view.statMany?.(paths, { follow: false });
        const verified =
          result?.length === 1000 &&
          result.every((row) => "stat" in row && row.stat.kind === "file");
        rows.push({
          operation: "metadata",
          credentials,
          version,
          verified,
          statements: meter.statements,
          rowsRead: meter.rowsRead,
          rowsWritten: meter.rowsWritten,
        });
      }
    }
    for (const version of order === "candidate"
      ? ["candidate", "baseline"]
      : ["baseline", "candidate"]) {
      meter.reset();
      const result =
        version === "baseline" ? fs.find({ path: "/", includeRoot: true }) : index.refresh();
      rows.push({
        operation: "incremental",
        credentials: false,
        version,
        verified: result !== undefined,
        statements: meter.statements,
        rowsRead: meter.rowsRead,
        rowsWritten: meter.rowsWritten,
      });
    }
    const current = fs
      .find({ path: "/", includeRoot: true })
      .sort((a, b) => a.path.localeCompare(b.path));
    const cached = index.snapshot().sort((a, b) => a.path.localeCompare(b.path));
    if (JSON.stringify(current) !== JSON.stringify(cached)) throw new Error("snapshot mismatch");
    await this.ctx.storage.deleteAll();
    return { rows, initialIndexCost };
  }
}
export default {
  async fetch(request: Request, env: CapabilityEnv): Promise<Response> {
    const expected = new TextEncoder().encode(`Bearer ${env.EVALUATION_TOKEN}`);
    const supplied = new TextEncoder().encode(request.headers.get("Authorization") ?? "");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
      return new Response("Unauthorized", { status: 401 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const url = new URL(request.url);
    const room = url.searchParams.get("room");
    if (room === null || room.length > 100) return new Response("Invalid room", { status: 400 });
    const stub = env.EVALUATIONS.getByName(room);
    try {
      const result =
        url.searchParams.get("mode") === "mutation"
          ? await stub.mutationCosts()
          : await stub.evaluate(url.searchParams.get("order") ?? "baseline");
      return Response.json({
        build: "capabilities-28720507900c8a69",
        colo: request.cf?.colo,
        ...result,
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    } finally {
      await stub.clear();
    }
  },
} satisfies ExportedHandler<CapabilityEnv>;

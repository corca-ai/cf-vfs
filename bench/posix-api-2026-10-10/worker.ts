import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";
import { DurableObjectFileSystem } from "../../src/vfs/do-sql.js";
import { meterSqlStorage } from "../metered-sql.js";
import { DurableObjectFileSystem as BaselineFileSystem } from "./baseline/vfs/do-sql.js";

const count = 300;
const deep = "/work/a/b/c/d/e/f/g/h/i/j/k/l";
const operations = [
  "stat-shallow",
  "stat-deep",
  "stat-link",
  "stat-denied",
  "read-deep",
  "overwrite",
  "append-small",
  "append-large-tail",
  "mkdir-wide",
  "mkdir-deep",
  "rename",
  "unlink",
  "rmdir",
  "batch-parents",
];
function check(value: boolean, message: string): asserts value {
  if (!value) throw new Error(message);
}

export class PosixApiEvaluation extends DurableObject<PosixApiEvaluationEnv> {
  private readonly meter = meterSqlStorage(this.ctx.storage);
  private raw: DurableObjectFileSystem | BaselineFileSystem | undefined;
  private baseline: boolean | undefined;
  private filesystem(baseline: boolean) {
    if (this.raw !== undefined && this.baseline !== baseline)
      throw new Error("Reset between variants");
    this.baseline = baseline;
    this.raw ??= new (baseline ? BaselineFileSystem : DurableObjectFileSystem)(
      this.ctx.id.name?.includes("-profile") ? this.meter.storage : this.ctx.storage,
      {
        maxEntries: 10000,
        maxInlineLogicalBytes: 64 * 1024 * 1024,
      },
    );
    return this.raw;
  }
  async setup(name: string, baseline: boolean) {
    check(operations.includes(name), "Unknown operation");
    await this.ctx.storage.deleteAll();
    this.raw = undefined;
    const root = this.filesystem(baseline);
    await root.initialize();
    root.mkdir("/work");
    root.setOwnership("/work", { uid: 1000, gid: 1000 });
    const fs = root.forCredentials({ uid: 1000, gid: 1000 });
    fs.mkdir(deep, true);
    await fs.writeFile("/work/file", "a".repeat(768));
    await fs.writeFile(`${deep}/file`, "a".repeat(768));
    if (name === "stat-link") fs.symlink("/work/link", deep);
    fs.mkdir("/work/denied");
    fs.setMetadata("/work/denied", { mode: 0 });
    if (["rename", "unlink", "append-large-tail"].includes(name))
      for (let i = 0; i < count; i++)
        await fs.writeFile(
          `/work/f${i}`,
          name === "append-large-tail" ? "x".repeat(60000) : "data",
        );
    if (name === "rmdir") for (let i = 0; i < count; i++) fs.mkdir(`/work/d${i}`);
    return { ok: true };
  }
  async measure(name: string, baseline: boolean) {
    check(operations.includes(name), "Unknown operation");
    const fs = this.filesystem(baseline).forCredentials({ uid: 1000, gid: 1000 });
    this.meter.reset();
    for (let i = 0; i < count; i++) {
      switch (name) {
        case "stat-shallow":
          check(fs.stat("/work/file").sizeBytes === 768, "stat");
          break;
        case "stat-deep":
          check(fs.stat(`${deep}/file`).sizeBytes === 768, "deep stat");
          break;
        case "stat-link":
          check(fs.stat("/work/link/file").sizeBytes === 768, "link stat");
          break;
        case "stat-denied": {
          let denied = false;
          try {
            fs.stat("/work/denied/file");
          } catch (e) {
            denied = e instanceof Error && "code" in e && e.code === "EACCES";
          }
          check(denied, "permission denial");
          break;
        }
        case "read-deep":
          check(
            (await new Response(fs.readFile(`${deep}/file`).stream).arrayBuffer()).byteLength ===
              768,
            "read",
          );
          break;
        case "overwrite":
          await fs.writeFile("/work/file", "z".repeat(768));
          break;
        case "append-small":
          await fs.appendFile("/work/file", "xyz");
          break;
        case "append-large-tail":
          await fs.appendFile(`/work/f${i}`, "xyz");
          break;
        case "mkdir-wide":
          fs.mkdir(`/work/d${i}`);
          break;
        case "mkdir-deep":
          fs.mkdir(`${deep}/d${i}`);
          break;
        case "rename":
          await fs.move(`/work/f${i}`, `/work/g${i}`);
          break;
        case "unlink":
          await fs.remove(`/work/f${i}`);
          break;
        case "batch-parents":
          if (i === 0)
            await fs.writeFiles(
              Array.from({ length: count }, (_, index) => ({
                path: `/work/p${index}/nested/file`,
                body: "x".repeat(768),
              })),
              { createParents: true },
            );
          break;
        case "rmdir":
          await fs.remove(`/work/d${i}`);
          break;
      }
    }
    return {
      count,
      counters: {
        statements: this.meter.statements,
        rowsRead: this.meter.rowsRead,
        rowsWritten: this.meter.rowsWritten,
      },
    };
  }
  async validate(name: string, baseline: boolean) {
    const fs = this.filesystem(baseline).forCredentials({ uid: 1000, gid: 1000 });
    if (name === "append-small")
      check(
        (await new Response(fs.readFile("/work/file").stream).text()) ===
          "a".repeat(768) + "xyz".repeat(count),
        "append body",
      );
    if (name === "append-large-tail")
      for (let i = 0; i < count; i++)
        check(
          (await new Response(fs.readFile(`/work/f${i}`).stream).text()) ===
            `${"x".repeat(60000)}xyz`,
          "large append body",
        );
    if (name === "mkdir-wide") check(fs.stat("/work").nlink === 304, "parent link count");
    if (name === "mkdir-deep") check(fs.stat(deep).nlink === 302, "deep parent link count");
    if (name === "batch-parents") {
      check(
        fs.stat("/work").nlink === 304 && fs.stat("/work/p5").nlink === 3,
        "wide parent counts",
      );
      for (let i = 0; i < count; i++)
        check(
          (await new Response(fs.readFile(`/work/p${i}/nested/file`).stream).text()) ===
            "x".repeat(768),
          "batch body",
        );
    }
    if (name === "rmdir") check(fs.stat("/work").nlink === 4, "removed parent link count");
    if (name === "overwrite")
      check(
        (await new Response(fs.readFile("/work/file").stream).text()) === "z".repeat(768),
        "overwritten body",
      );
    if (name === "rename")
      for (let i = 0; i < count; i++)
        check(
          (await new Response(fs.readFile(`/work/g${i}`).stream).text()) === "data",
          "renamed body",
        );
    if (name === "unlink" || name === "rmdir")
      check(
        fs.list("/work").every((entry) => !/^[fd]\d+$/u.test(entry.name)),
        "removed names",
      );
    return { ok: true };
  }
  async clear() {
    await this.ctx.storage.deleteAll();
    this.raw = undefined;
    return { ok: true };
  }
}

export default {
  async fetch(request: Request, env: PosixApiEvaluationEnv) {
    const supplied = new TextEncoder().encode(request.headers.get("Authorization") ?? "");
    const expected = new TextEncoder().encode(`Bearer ${env.EVALUATION_TOKEN}`);
    if (
      request.method !== "POST" ||
      supplied.byteLength !== expected.byteLength ||
      !timingSafeEqual(supplied, expected)
    )
      return new Response("Unauthorized", { status: 401 });
    const url = new URL(request.url),
      room = url.searchParams.get("room") ?? "";
    if (!/^posix-[a-z0-9-]{1,100}$/u.test(room))
      return new Response("Invalid room", { status: 400 });
    const stub = env.EVALUATIONS.getByName(room),
      name = url.searchParams.get("name") ?? "";
    const baseline = url.searchParams.get("version") === "baseline";
    const start = performance.now();
    try {
      const value =
        url.pathname === "/setup"
          ? await stub.setup(name, baseline)
          : url.pathname === "/measure"
            ? await stub.measure(name, baseline)
            : url.pathname === "/validate"
              ? await stub.validate(name, baseline)
              : url.pathname === "/clear"
                ? await stub.clear()
                : undefined;
      if (value === undefined) return new Response("Not found", { status: 404 });
      return Response.json({ value, rpcMs: performance.now() - start });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<PosixApiEvaluationEnv>;

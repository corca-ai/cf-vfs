import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";
import * as git from "isomorphic-git";
import { CollaborativeFileSystem, DocumentRegistry } from "../../src/collab/index.js";
import { createFsAdapter } from "../../src/fs/index.js";
import { gitCommand } from "../../src/shell/commands/git.js";
import { Shell } from "../../src/shell/shell.js";
import { DurableObjectFileSystem } from "../../src/vfs/do-sql.js";
import { meterSqlStorage } from "../metered-sql.js";
import {
  CollaborativeFileSystem as BaselineCollab,
  DocumentRegistry as BaselineRegistry,
} from "./baseline/collab/index.js";
import { createFsAdapter as baselineAdapter } from "./baseline/fs/index.js";
import { gitCommand as baselineGit } from "./baseline/shell/commands/git.js";
import { Shell as BaselineShell } from "./baseline/shell/shell.js";
import { DurableObjectFileSystem as BaselineFileSystem } from "./baseline/vfs/do-sql.js";

export class NoApiEvaluation extends DurableObject<NoApiEvaluationEnv> {
  private readonly baseline = this.ctx.id.name?.includes("-baseline") === true;
  private readonly meter = meterSqlStorage(this.ctx.storage);
  private readonly raw = new (this.baseline ? BaselineFileSystem : DurableObjectFileSystem)(
    this.ctx.id.name?.includes("-profile") ? this.meter.storage : this.ctx.storage,
    { maxInlineLogicalBytes: 32 * 1024 * 1024 },
  );
  private readonly view = this.baseline
    ? new BaselineCollab(this.raw, new BaselineRegistry())
    : new CollaborativeFileSystem(this.raw, new DocumentRegistry());
  private readonly shell = new (this.baseline ? BaselineShell : Shell)({
    fileSystem: this.view,
    commands: [this.ctx.id.name?.includes("-baseline") ? baselineGit : gitCommand],
  });
  private async run(script: string, cwd = "/repo") {
    const result = await this.shell.executeText({ script, cwd });
    if (result.exitCode !== 0) throw new Error(`${script}: ${result.stderr}`);
    return result;
  }
  async setup(pack: boolean, generations: number) {
    if (generations !== 1 && generations !== 2) throw new Error("Invalid generation count");
    const fs = (this.baseline ? baselineAdapter : createFsAdapter)(this.raw);
    for (const path of ["/repo", "/copy"])
      await fs.promises.rm(path, { recursive: true, force: true });
    await this.run("git init /repo", "/");
    await this.run("git config user.name Bench; git config user.email bench@example.invalid");
    for (let generation = 0; generation < generations; generation++) {
      for (let n = 0; n < 1000; n++) {
        let seed = n + generation * 1000 + 1;
        const bytes = Uint8Array.from({ length: 768 }, () => {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          return 32 + ((seed >>> 24) % 95);
        });
        await this.raw.writeFile(`/repo/f${n}`, bytes);
      }
      await this.run(`git add -A; git commit -m generation${generation}`);
      if (generation === 0) await this.run("git branch base");
    }
    if (pack) await this.pack();
    return { ok: true, allocatedBytes: this.ctx.storage.sql.databaseSize };
  }
  async pack() {
    const before = this.ctx.storage.sql.databaseSize;
    const fs = (this.baseline ? baselineAdapter : createFsAdapter)(this.raw);
    const dirs = this.raw.list("/repo/.git/objects").filter((e) => /^[a-f0-9]{2}$/u.test(e.name));
    const oids = dirs.flatMap((dir) => this.raw.list(dir.path).map((e) => dir.name + e.name));
    const { filename } = await git.packObjects({ fs, dir: "/repo", oids, write: true });
    const index = await git.indexPack({
      fs,
      dir: "/repo",
      filepath: `.git/objects/pack/${filename}`,
    });
    if (index.oids.length !== oids.length) throw new Error("Pack did not retain all objects");
    for (const dir of dirs) await this.raw.remove(dir.path, { recursive: true });
    return {
      objects: oids.length,
      beforeAllocatedBytes: before,
      afterAllocatedBytes: this.ctx.storage.sql.databaseSize,
      packBytes: this.raw.stat(`/repo/.git/objects/pack/${filename}`).sizeBytes,
    };
  }
  async measure(operation: string) {
    const scripts: Record<string, string> = {
      status: "git status --porcelain",
      add: "git add -A",
      clone: "git clone /repo /copy",
      checkout: "git -C /copy checkout base",
      "add-all": "git add -A",
      "checkout-all": "git checkout base",
    };
    const script = scripts[operation];
    if (script === undefined) throw new Error("Invalid operation");

    this.meter.reset();
    const result = await this.run(script);
    const counters = {
      statements: this.meter.statements,
      rowsRead: this.meter.rowsRead,
      rowsWritten: this.meter.rowsWritten,
    };
    return { stdout: result.stdout, counters };
  }
  async prepareClone() {
    await (this.baseline ? baselineAdapter : createFsAdapter)(this.raw).promises.rm("/copy", {
      recursive: true,
      force: true,
    });
    return { ok: true };
  }
  async change(all = false) {
    if (all) {
      await this.raw.writeFiles(
        Array.from({ length: 1000 }, (_, n) => ({
          path: `/repo/f${n}`,
          body: `changed-${n}`.padEnd(768, "x"),
        })),
      );
    } else await this.raw.writeFile("/repo/f7", "changed".repeat(100));
    return { ok: true };
  }
  async commit() {
    await this.run("git commit -m all");
    return { ok: true };
  }
  async validate() {
    const fs = (this.baseline ? baselineAdapter : createFsAdapter)(this.raw);
    const dir = this.raw.list("/").some((entry) => entry.name === "copy") ? "/copy" : "/repo";
    const cache = {};
    const head = await git.resolveRef({ fs, dir, ref: "HEAD" });
    const files = await git.listFiles({ fs, dir });
    for (const filepath of files) {
      const { blob } = await git.readBlob({ fs, dir, oid: head, filepath, cache });
      const body = await fs.promises.readFile(`${dir}/${filepath}`);
      if (blob.length !== body.length || blob.some((byte, i) => byte !== body[i]))
        throw new Error(`Body differs: ${filepath}`);
    }
    return { verified: files.length, head };
  }
  async clear() {
    await this.ctx.storage.deleteAll();
    return { cleared: true };
  }
}

export default {
  async fetch(request: Request, env: NoApiEvaluationEnv): Promise<Response> {
    const expected = new TextEncoder().encode(`Bearer ${env.EVALUATION_TOKEN}`);
    const supplied = new TextEncoder().encode(request.headers.get("Authorization") ?? "");
    if (
      !env.EVALUATION_TOKEN ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return new Response("Unauthorized", { status: 401 });
    const url = new URL(request.url);
    const room = url.searchParams.get("room") ?? "";
    if (request.method !== "POST" || !/^[a-z0-9-]{1,80}$/u.test(room))
      return new Response("Invalid request", { status: 400 });
    const object = env.EVALUATIONS.getByName(room);
    try {
      const started = performance.now();
      let value: unknown;
      switch (url.pathname) {
        case "/setup":
          value = await object.setup(
            url.searchParams.get("pack") === "true",
            Number(url.searchParams.get("generations") ?? 1),
          );
          break;
        case "/pack":
          value = await object.pack();
          break;
        case "/measure":
          value = await object.measure(url.searchParams.get("operation") ?? "status");
          break;
        case "/prepare-clone":
          value = await object.prepareClone();
          break;
        case "/change":
          value = await object.change(url.searchParams.get("all") === "true");
          break;
        case "/commit":
          value = await object.commit();
          break;
        case "/validate":
          value = await object.validate();
          break;
        case "/clear":
          value = await object.clear();
          break;
        default:
          return new Response("Not found", { status: 404 });
      }
      return Response.json({ value, rpcMs: performance.now() - started });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
} satisfies ExportedHandler<NoApiEvaluationEnv>;

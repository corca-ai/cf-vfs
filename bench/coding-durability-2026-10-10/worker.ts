import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";
import * as git from "isomorphic-git";
import { RECOVERY_OPERATIONS, runGitRecovery } from "../../demo/benchmark-git-recovery.js";
import { workflowBody } from "../../demo/benchmark-git-workflow.js";
import { DemoDocuments } from "../../demo/document.js";
import { WorkspaceOperations } from "../../demo/workspace-operations.js";
import { CollaborativeFileSystem } from "../../src/collab/index.js";
import { createFsAdapter } from "../../src/fs/index.js";
import { gitCommand } from "../../src/shell/commands/git.js";
import { Shell } from "../../src/shell/shell.js";
import { DurableObjectFileSystem } from "../../src/vfs/do-sql.js";
import { readAllBytes } from "../../src/vfs/streams.js";
import { meterSqlStorage } from "../metered-sql.js";

/** Isolated evaluation host: no reference to the public demo's namespaces. */
export class CodingEvaluation extends DurableObject<CodingEvaluationEnv> {
  private readonly instance = crypto.randomUUID();
  private maximum = 32 * 1024 * 1024;
  private readonly meter = meterSqlStorage(this.ctx.storage);
  private readonly raw = new DurableObjectFileSystem(
    this.ctx.id.name?.endsWith("-profile") === true ? this.meter.storage : this.ctx.storage,
    {
      maxInlineLogicalBytes: () => this.maximum,
    },
  );
  private readonly documents = new DemoDocuments();
  private readonly editable = new CollaborativeFileSystem(this.raw, this.documents.registry);
  private readonly queue = new WorkspaceOperations();
  private readonly notices: string[] = [];
  private readonly shell = new Shell({ fileSystem: this.editable, commands: [gitCommand] });

  constructor(ctx: DurableObjectState, env: CodingEvaluationEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.maximum = (await ctx.storage.get<number>("evaluation:quota")) ?? 32 * 1024 * 1024;
    });
    this.documents.attach(
      this.editable,
      (notice) => {
        this.notices.push(JSON.stringify(notice));
      },
      (operation) => this.queue.run(operation),
    );
  }

  async execute(script: string, profile: boolean) {
    return this.queue.run(async () => {
      const savedBefore = await this.documents.flush();
      this.meter.reset();
      const result = await this.shell.executeText({ script, cwd: "/repo" });
      const counters = profile
        ? {
            statements: this.meter.statements,
            rowsRead: this.meter.rowsRead,
            rowsWritten: this.meter.rowsWritten,
          }
        : undefined;
      const savedAfter = await this.documents.flush();
      return {
        ...result,
        instance: this.instance,
        savedBefore,
        savedAfter,
        ...(counters === undefined ? {} : { counters }),
      };
    });
  }

  async pair() {
    return Promise.all([
      this.execute("git checkout base", false),
      this.execute("git status --porcelain", false),
    ]);
  }

  async setup(files: number, mixed: boolean) {
    if (!Number.isInteger(files) || files < 1 || files > 1000)
      throw new Error("Invalid file count");
    this.documents.dispose();
    await this.quota(32 * 1024 * 1024);
    const fs = createFsAdapter(this.raw);
    for (const path of ["/repo", "/copy"])
      await fs.promises.rm(path, { recursive: true, force: true });
    const result = await this.shell.executeText({ script: "git init /repo" });
    if (result.exitCode !== 0) throw new Error(result.stderr);
    for (let n = 0; n < files; n++) await this.raw.writeFile(`/repo/f${n}`, workflowBody(n, mixed));
    const initial = await this.execute(
      "git config user.name Evaluation; git config user.email eval@example.invalid; git add -A; git commit -m base; git branch base",
      false,
    );
    if (initial.exitCode !== 0) throw new Error(initial.stderr);
    return this.inspect();
  }

  async inspect() {
    const fs = createFsAdapter(this.raw);
    const opts = { fs, dir: "/repo" };
    const files = await git.listFiles(opts);
    const head = await git.resolveRef({ ...opts, ref: "HEAD" });
    let verified = 0;
    for (const path of files) {
      const { blob } = await git.readBlob({ ...opts, oid: head, filepath: path });
      if (blob.length === 0) throw new Error(`Empty committed blob: ${path}`);
      verified++;
    }
    const index = await fs.promises.readFile("/repo/.git/index");
    const digest = await crypto.subtle.digest("SHA-256", index);
    return {
      instance: this.instance,
      maximum: this.maximum,
      head,
      files,
      verified,
      indexHash: Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join(
        "",
      ),
      body: await fs.promises.readFile("/repo/f0", "utf8"),
      notices: this.notices.splice(0),
    };
  }

  async edit(text: string) {
    return this.queue.run(async () => {
      const document = await this.documents.open("/repo/f0");
      this.documents.applyClientText("/repo/f0", document.version(), text);
      return { text: document.text(), version: document.version(), instance: this.instance };
    });
  }

  async change(all: boolean) {
    const paths = await git.listFiles({ fs: createFsAdapter(this.raw), dir: "/repo" });
    for (const path of all ? paths : ["f0"]) {
      const body = await createFsAdapter(this.raw).promises.readFile(`/repo/${path}`);
      body[0] = (body[0] ?? 0) ^ 1;
      await this.raw.writeFile(`/repo/${path}`, body);
    }
    return { changed: all ? paths.length : 1 };
  }

  async recovery(operation: string) {
    const selected = RECOVERY_OPERATIONS.find((value) => value === operation);
    if (selected === undefined) throw new Error("Invalid recovery operation");
    return runGitRecovery(this.raw, selected);
  }

  async quota(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 32 * 1024 * 1024)
      throw new Error("Invalid quota");
    this.maximum = bytes;
    await this.ctx.storage.put("evaluation:quota", bytes);
    return { maximum: bytes, instance: this.instance };
  }

  async restart(checkout: boolean) {
    if (checkout) {
      let writes = 0;
      const vfs = this.raw;
      const ctx = this.ctx;
      const faulty = new Proxy(vfs, {
        get(target, property) {
          if (property === "forCredentials") return undefined;
          if (property === "writeFile")
            return async (...args: Parameters<typeof vfs.writeFile>) => {
              if (args[0].startsWith("/repo/f") && ++writes === 8) {
                await ctx.storage.sync();
                ctx.abort("Coding evaluation: restart during checkout");
              }
              return target.writeFile(...args);
            };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await new Shell({ fileSystem: faulty, commands: [gitCommand] }).executeText({
        script: "git checkout base",
        cwd: "/repo",
      });
      throw new Error("Checkout restart was not reached");
    }
    await this.ctx.storage.sync();
    this.ctx.abort("Coding evaluation: explicit restart");
  }

  async clear() {
    this.documents.dispose();
    await this.ctx.storage.deleteAll();
    return { cleared: true };
  }
}

export default {
  async fetch(request: Request, env: CodingEvaluationEnv): Promise<Response> {
    if (!env.EVALUATION_TOKEN) return new Response("Unavailable", { status: 503 });
    const supplied = new TextEncoder().encode(request.headers.get("Authorization") ?? "");
    const expected = new TextEncoder().encode(`Bearer ${env.EVALUATION_TOKEN}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return new Response("Unauthorized", { status: 401 });
    if (request.method !== "POST") return new Response("Use POST", { status: 405 });
    const url = new URL(request.url);
    const room = url.searchParams.get("room") ?? "evaluation";
    if (!/^[a-z0-9-]{1,80}$/u.test(room)) return new Response("Invalid room", { status: 400 });
    const object = env.EVALUATIONS.getByName(room);
    try {
      switch (url.pathname) {
        case "/setup":
          return Response.json(
            await object.setup(
              Number(url.searchParams.get("files") ?? 100),
              url.searchParams.get("mixed") === "true",
            ),
          );
        case "/execute": {
          const script = await requestText(request);
          if (script.length > 128 * 1024) return new Response("Too large", { status: 413 });
          return Response.json(
            await object.execute(script, url.searchParams.get("profile") === "true"),
          );
        }
        case "/change":
          return Response.json(await object.change(url.searchParams.get("all") === "true"));
        case "/recovery":
          return Response.json(await object.recovery(url.searchParams.get("operation") ?? ""));
        case "/pair":
          return Response.json({ results: await object.pair() });
        case "/inspect":
          return Response.json(await object.inspect());
        case "/edit":
          return Response.json(await object.edit(await requestText(request)));
        case "/quota":
          return Response.json(await object.quota(Number(url.searchParams.get("bytes"))));
        case "/restart":
          return Response.json(await object.restart(url.searchParams.get("checkout") === "true"));
        case "/clear":
          return Response.json(await object.clear());
        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<CodingEvaluationEnv>;

async function requestText(request: Request): Promise<string> {
  if (request.body === null) return "";
  return new TextDecoder().decode(await readAllBytes(request.body, 128 * 1024));
}

import { DurableObject } from "cloudflare:workers";
import { DurableObjectFileSystem } from "../../src/vfs/do-sql.js";
import { authorized, body, HttpError, json } from "../http.js";

/**
 * A SQL laboratory on Cloudflare: Durable Objects holding a real cf-vfs
 * schema, seeded through the filesystem, that run arbitrary statements so a
 * query design can be measured where it will run without a deploy per idea.
 *
 * Deliberately its own Worker. Arbitrary SQL is every right over an object's
 * data, so it never shares a namespace with evaluation workspaces or the
 * public benchmark, and every lab deletes itself a day after it is seeded.
 * Results are for exploration; adopting a query in the library still follows
 * the performance protocol.
 */

interface LabEnv {
  readonly LAB_TOKEN?: string;
  readonly SQL_LAB: DurableObjectNamespace<SqlLab>;
}

const LAB_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const LAB_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SEED_FILES = 1_000;
const MAX_STATEMENTS = 64;
const MAX_REPEAT = 1_000;
const MAX_ROWS = 1_000;
const MAX_CELL_CHARS = 200;

type Binding = string | number | null;
type ReadMode = "stream" | "cancel" | "stat";

interface Statement {
  readonly sql: string;
  readonly params: readonly Binding[];
}

interface StatementResult {
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number;
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

/** A cell short enough to return: long text truncated, blobs reported by size. */
function cell(value: SqlStorageValue): unknown {
  if (value instanceof ArrayBuffer) return { blobBytes: value.byteLength };
  if (typeof value === "string" && value.length > MAX_CELL_CHARS) {
    return `${value.slice(0, MAX_CELL_CHARS)}… (${value.length} chars)`;
  }
  return value;
}

export class SqlLab extends DurableObject<LabEnv> {
  private readonly fileSystem: DurableObjectFileSystem;

  constructor(ctx: DurableObjectState, env: LabEnv) {
    super(ctx, env);
    this.fileSystem = new DurableObjectFileSystem(ctx.storage, { workspaceId: ctx.id.toString() });
    ctx.blockConcurrencyWhile(() => this.fileSystem.initialize());
  }

  /** Writes files through the filesystem, so the rows are the library's own. */
  async seed(files: readonly { path: string; content: string }[]): Promise<number> {
    await this.fileSystem.writeFiles(
      files.map((file) => ({
        path: file.path.startsWith("/") ? file.path : `/${file.path}`,
        body: file.content,
      })),
      { createParents: true },
    );
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + LAB_TTL_MS);
    }
    return files.length;
  }

  /**
   * Runs the statements `repeat` times in one request and returns the first
   * repetition's rows. A statement's own duration cannot be read inside the
   * object, whose clock stands still during synchronous SQL, so callers time
   * the request and divide by `repeat`.
   */
  sql(statements: readonly Statement[], repeat: number, maxRows: number): StatementResult[] {
    const results: StatementResult[] = [];
    for (let round = 0; round < repeat; round += 1) {
      statements.forEach((statement, index) => {
        const cursor = this.ctx.storage.sql.exec(statement.sql, ...statement.params);
        const rows: Record<string, unknown>[] = [];
        let rowCount = 0;
        for (const row of cursor) {
          rowCount += 1;
          if (round === 0 && rows.length < maxRows) {
            rows.push(
              Object.fromEntries(Object.entries(row).map(([key, value]) => [key, cell(value)])),
            );
          }
        }
        if (round === 0) {
          results[index] = {
            columns: cursor.columnNames,
            rows,
            rowCount,
            rowsRead: cursor.rowsRead,
            rowsWritten: cursor.rowsWritten,
          };
        }
      });
    }
    return results;
  }

  /**
   * Reads files through the filesystem, one call each, as shell commands do:
   * `stream` consumes each body, `cancel` opens and cancels it, and `stat`
   * only stats.
   */
  async readFiles(paths: readonly string[], mode: ReadMode): Promise<number> {
    let bytes = 0;
    for (const path of paths) {
      if (mode === "stat") {
        bytes += this.fileSystem.stat(path).sizeBytes;
        continue;
      }
      const read = this.fileSystem.readFile(path);
      if (mode === "cancel") {
        await read.stream.cancel();
        bytes += read.stat.sizeBytes;
        continue;
      }
      const reader = read.stream.getReader();
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        bytes += next.value.byteLength;
      }
    }
    return bytes;
  }

  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

function bindings(value: unknown): Binding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "params must be an array");
  return value.map((item) => {
    if (item === null || typeof item === "string" || typeof item === "number") return item;
    throw new HttpError(400, "params must be strings, numbers or null");
  });
}

function statements(value: unknown): Statement[] {
  if (!Array.isArray(value) || value.length > MAX_STATEMENTS) {
    throw new HttpError(400, `statements must be an array of at most ${MAX_STATEMENTS}`);
  }
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || typeof item.sql !== "string") {
      throw new HttpError(400, `statements[${index}] needs a string sql`);
    }
    return { sql: item.sql, params: bindings(item.params) };
  });
}

function bounded(value: unknown, fallback: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new HttpError(400, `${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function seedFiles(value: unknown): { path: string; content: string }[] {
  if (!Array.isArray(value) || value.length > MAX_SEED_FILES) {
    throw new HttpError(400, `files must be an array of at most ${MAX_SEED_FILES}`);
  }
  return value.map((item, index) => {
    if (typeof item?.path !== "string" || typeof item?.content !== "string") {
      throw new HttpError(400, `files[${index}] needs string path and content`);
    }
    return { path: item.path, content: item.content };
  });
}

function paths(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new HttpError(400, "paths must be an array of strings");
  }
  return value;
}

async function route(request: Request, env: LabEnv): Promise<Response> {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  const [prefix, name, action] = segments;
  if (prefix !== "lab" || name === undefined || !LAB_NAME.test(name) || segments.length > 3) {
    throw new HttpError(404, "not found");
  }
  const lab = env.SQL_LAB.getByName(name);
  if (action === undefined && request.method === "DELETE") {
    await lab.destroy();
    return new Response(null, { status: 204 });
  }
  if (request.method !== "POST") throw new HttpError(405, "method not allowed");
  const input = await body(request);
  // Timed at the Worker: the request crosses I/O, so its clock moves.
  const started = Date.now();
  const respond = (value: Record<string, unknown>) => json({ ...value, ms: Date.now() - started });
  try {
    if (action === "seed") return respond({ written: await lab.seed(seedFiles(input["files"])) });
    if (action === "sql") {
      const repeat = bounded(input["repeat"], 1, MAX_REPEAT, "repeat");
      const maxRows = bounded(input["maxRows"], 20, MAX_ROWS, "maxRows");
      const results = await lab.sql(statements(input["statements"]), repeat, maxRows);
      return respond({ repeat, results });
    }
    if (action === "read") {
      const mode = input["mode"] ?? "stream";
      if (mode !== "stream" && mode !== "cancel" && mode !== "stat") {
        throw new HttpError(400, "mode must be stream, cancel or stat");
      }
      return respond({ bytes: await lab.readFiles(paths(input["paths"]), mode) });
    }
  } catch (caught) {
    if (caught instanceof HttpError) throw caught;
    throw new HttpError(400, caught instanceof Error ? caught.message : String(caught));
  }
  throw new HttpError(404, "not found");
}

export default {
  async fetch(request, env): Promise<Response> {
    if (!(await authorized(request, env.LAB_TOKEN))) return json({ error: "unauthorized" }, 401);
    try {
      return await route(request, env);
    } catch (caught) {
      if (caught instanceof HttpError) return json({ error: caught.message }, caught.status);
      throw caught;
    }
  },
} satisfies ExportedHandler<LabEnv>;

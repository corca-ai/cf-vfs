import { DurableObject } from "cloudflare:workers";
import { utf8ByteLength } from "../../src/core/unicode.js";
import { parsePage } from "../../src/shell/commands/awiki-parse.js";
import { createBytePipe } from "../../src/shell/pipe.js";
import { DurableObjectFileSystem } from "../../src/vfs/do-sql.js";
import type { SqlFileSystem } from "../../src/vfs/sql.js";
import { streamFromOwnedChunks } from "../../src/vfs/streams.js";
import { authorized, body, HttpError, json } from "../http.js";
import { evalShell } from "../profile.js";

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
type ReadMode = "stream" | "cancel" | "stat" | "many" | "many-stream" | "decode" | "parse";

interface ShellRun {
  readonly exitCode: number;
  readonly stdoutBytes: number;
  readonly stdout: string;
  readonly stderr: string;
}

const BODY = new TextEncoder().encode("x".repeat(5000));
const LINE = `${"a wiki line of ordinary prose with a [[link]] in it, ".repeat(4)}\n`;
const ENCODER = new TextEncoder();
const SCRATCH = new Uint8Array(64 * 1024);

function scannedUtf8Length(value: string): number {
  let bytes = value.length;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) continue;
    if (code < 0x800) bytes += 1;
    else if (code >= 0xd800 && code < 0xdc00 && index + 1 < value.length) {
      bytes += 2;
      index += 1;
    } else bytes += 2;
  }
  return bytes;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  let bytes = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    bytes += next.value.byteLength;
  }
  return bytes;
}

async function* counting(n: number): AsyncGenerator<number> {
  for (let index = 0; index < n; index += 1) yield index;
}

/**
 * Fixed microbenchmarks of runtime operations the shell performs per file or
 * per line, run `n` times each. The object's clock stands still while they
 * run, so callers time the request.
 */
const MICRO: Record<string, (n: number) => Promise<number> | number> = {
  empty: () => 0,
  "sync-call": (n) => {
    let total = 0;
    for (let index = 0; index < n; index += 1) total += String(index).slice(1).length;
    return total;
  },
  "await-resolved": async (n) => {
    let total = 0;
    for (let index = 0; index < n; index += 1) total += await Promise.resolve(1);
    return total;
  },
  "async-generator": async (n) => {
    let total = 0;
    for await (const value of counting(n)) total += value;
    return total;
  },
  "date-now": (n) => {
    let total = 0;
    for (let index = 0; index < n; index += 1) total += Date.now() & 1;
    return total;
  },
  "abort-listener": (n) => {
    const signal = new AbortController().signal;
    const listener = () => undefined;
    for (let index = 0; index < n; index += 1) {
      signal.addEventListener("abort", listener, { once: true });
      signal.removeEventListener("abort", listener);
    }
    return n;
  },
  "text-decode": (n) => {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let total = 0;
    for (let index = 0; index < n; index += 1)
      total += decoder.decode(BODY, { stream: true }).length;
    return total;
  },
  "line-encode": (n) => {
    let total = 0;
    for (let index = 0; index < n; index += 1) total += ENCODER.encode(LINE).byteLength;
    return total;
  },
  "line-encode-into": (n) => {
    let total = 0;
    for (let index = 0; index < n; index += 1) total += ENCODER.encodeInto(LINE, SCRATCH).written;
    return total;
  },
  "line-scan": (n) => {
    let total = 0;
    for (let index = 0; index < n; index += 1) total += scannedUtf8Length(LINE);
    return total;
  },
  "line-ascii-regex": (n) => {
    let total = 0;
    for (let index = 0; index < n; index += 1) {
      total += /[\u0080-\u{10ffff}]/u.test(LINE) ? 0 : LINE.length;
    }
    return total;
  },
  nfc: (n) => {
    let total = 0;
    for (let index = 0; index < n; index += 1)
      total += `design/note-${index & 1023}`.normalize("NFC").length;
    return total;
  },
  "nfc-ascii-checked": (n) => {
    let total = 0;
    for (let index = 0; index < n; index += 1) {
      const name = `design/note-${index & 1023}`;
      total += (/[\u0080-\u{10ffff}]/u.test(name) ? name.normalize("NFC") : name).length;
    }
    return total;
  },
  lowercase: (n) => {
    let total = 0;
    for (let index = 0; index < n; index += 1)
      total += `Design/Note-${index & 1023}`.toLowerCase().length;
    return total;
  },
  "utf8-length": (n) => {
    let total = 0;
    for (let index = 0; index < n; index += 1) total += utf8ByteLength(LINE);
    return total;
  },
  "pipe-lines": async (n) => {
    // The shell's pipe, one short line per write, drained as it is written.
    const pipe = createBytePipe({
      maximumBytes: 64 * 1024 * 1024,
      signal: new AbortController().signal,
      name: "lab pipe",
    });
    const line = new TextEncoder().encode("a line of about thirty bytes\n");
    const drained = drain(pipe.readable);
    for (let index = 0; index < n; index += 1) await pipe.sink.write(line);
    await pipe.sink.close();
    return await drained;
  },
  "copy-body": (n) => {
    let total = 0;
    for (let index = 0; index < n; index += 1) total += BODY.slice().byteLength;
    return total;
  },
  "owned-stream": async (n) => {
    let total = 0;
    for (let index = 0; index < n; index += 1)
      total += await drain(streamFromOwnedChunks([BODY.slice()]));
    return total;
  },
  "default-stream": async (n) => {
    let total = 0;
    for (let index = 0; index < n; index += 1) {
      total += await drain(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(BODY.slice());
            controller.close();
          },
        }),
      );
    }
    return total;
  },
  "blob-stream": async (n) => {
    let total = 0;
    for (let index = 0; index < n; index += 1)
      total += await drain(new Blob([BODY.slice()]).stream());
    return total;
  },
};

/**
 * The filesystem a lab shell runs over: a fresh object per run, so caches
 * keyed by filesystem start cold, and with bulk reads withheld when asked.
 */
function shellFileSystem(fileSystem: SqlFileSystem, bulk: boolean): SqlFileSystem {
  const view = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(inner, property) {
        if (property === "readMany" && !bulk) return undefined;
        if (property === "forCredentials") {
          const forCredentials = Reflect.get(inner, property) as (...args: unknown[]) => object;
          return (...args: unknown[]) => view(forCredentials.apply(inner, args));
        }
        const value: unknown = Reflect.get(inner, property);
        return typeof value === "function" ? value.bind(inner) : value;
      },
    });
  return view(fileSystem);
}

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
    if (mode === "decode" || mode === "parse") {
      // awiki's first-run work per page after a bulk read: decode, then parse.
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      for (let at = 0; at < paths.length; at += 100) {
        for (const read of this.fileSystem.readMany(paths.slice(at, at + 100))) {
          if (read === undefined) throw new Error("a page was not read in bulk");
          const text = decoder.decode(read.chunks[0]);
          bytes += mode === "parse" ? parsePage(text).links.length : text.length;
        }
      }
      return bytes;
    }
    if (mode === "many" || mode === "many-stream") {
      for (let at = 0; at < paths.length; at += 100) {
        for (const read of this.fileSystem.readMany(paths.slice(at, at + 100))) {
          if (read === undefined) throw new Error("a page was not read in bulk");
          if (mode === "many") {
            bytes += read.stat.sizeBytes;
            continue;
          }
          const reader = streamFromOwnedChunks(read.chunks).getReader();
          for (let next = await reader.read(); !next.done; next = await reader.read()) {
            bytes += next.value.byteLength;
          }
        }
      }
      return bytes;
    }
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

  async micro(kind: string, n: number): Promise<number> {
    const run = MICRO[kind];
    if (run === undefined) throw new Error(`unknown microbenchmark ${kind}`);
    return await run(n);
  }

  /** Runs a script in a fresh evaluation shell over the lab's files. */
  async shell(script: string, bulk: boolean): Promise<ShellRun> {
    const shell = evalShell(shellFileSystem(this.fileSystem, bulk), "/");
    const result = await shell.executeText({ script });
    return {
      exitCode: result.exitCode,
      stdoutBytes: result.stdout.length,
      stdout: result.stdout.slice(0, 2000),
      stderr: result.stderr.slice(0, 2000),
    };
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

function isReadMode(value: unknown): value is ReadMode {
  return ["stream", "cancel", "stat", "many", "many-stream", "decode", "parse"].includes(
    value as string,
  );
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
    if (action === "micro") {
      const kind = input["kind"];
      if (typeof kind !== "string") throw new HttpError(400, "kind must be a string");
      const n = bounded(input["n"], 1, 10_000_000, "n");
      return respond({ result: await lab.micro(kind, n) });
    }
    if (action === "shell") {
      const script = input["script"];
      if (typeof script !== "string") throw new HttpError(400, "script must be a string");
      return respond({ ...(await lab.shell(script, input["bulk"] !== false)) });
    }
    if (action === "read") {
      const mode = input["mode"] ?? "stream";
      if (!isReadMode(mode)) {
        throw new HttpError(400, "mode must be stream, cancel, stat, many or many-stream");
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

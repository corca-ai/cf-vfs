import { DurableObject } from "cloudflare:workers";
import { meterSqlStorage, type SqlMeter } from "../bench/metered-sql.js";
import { VfsError } from "../src/core/errors.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { gitCommand } from "../src/shell/commands/git.js";
import type { ShellEvent } from "../src/shell/events.js";
import type {
  IdentityIds,
  IdentityNames,
  ResolvedIdentityIds,
  ResolvedIdentityNames,
  ShellIdentityResolver,
} from "../src/shell/identity.js";
import { InteractiveShell } from "../src/shell/interactive.js";
import {
  LINUX_SHELL_OPTIONS,
  LINUX_WORKSPACE,
  linuxShellEnvironment,
  provisionLinuxFilesystem,
} from "../src/shell/linux.js";
import type { ExecuteTextResult } from "../src/shell/types.js";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import type { VfsEvent } from "../src/vfs/events.js";
import type { PosixCredentials, VirtualFileSystem } from "../src/vfs/types.js";

/**
 * The account an agent runs as. Ordinary names on purpose: nothing an agent
 * can observe should announce an evaluation harness.
 */
const EVAL_USER = "user";
const EVAL_UID = 1_000;
const EVAL_GID = 1_000;
const EVAL_HOME = `/home/${EVAL_USER}`;
const EVAL_CREDENTIALS = Object.freeze({
  uid: EVAL_UID,
  gid: EVAL_GID,
  supplementaryGids: Object.freeze([]),
}) satisfies PosixCredentials;
const EVAL_UMASK = 0o022;
const EVAL_COMMANDS = [...defaultShellCommands, gitCommand];

const META_KEY = "eval:meta";
const CWD_KEY = "eval:cwd";
/** Bounds what one log row keeps; the exec response always carries the full output. */
const LOGGED_OUTPUT_BYTES = 64 * 1024;
const MAX_RECORDED_COMMANDS = 500;
const MAX_LOG_PAGE = 500;

const USERS_BY_ID = new Map([
  [0, "root"],
  [EVAL_UID, EVAL_USER],
]);
const GROUPS_BY_ID = new Map([
  [0, "root"],
  [EVAL_GID, EVAL_USER],
]);
const USERS_BY_NAME = new Map([...USERS_BY_ID].map(([id, name]) => [name, id]));
const GROUPS_BY_NAME = new Map([...GROUPS_BY_ID].map(([id, name]) => [name, id]));

function select<Key, Value>(
  requested: readonly Key[],
  directory: ReadonlyMap<Key, Value>,
): Map<Key, Value> {
  const resolved = new Map<Key, Value>();
  for (const key of requested) {
    const value = directory.get(key);
    if (value !== undefined) resolved.set(key, value);
  }
  return resolved;
}

const EVAL_IDENTITY_RESOLVER: ShellIdentityResolver = Object.freeze({
  resolveIds({ uids, gids }: IdentityIds): ResolvedIdentityNames {
    return { users: select(uids, USERS_BY_ID), groups: select(gids, GROUPS_BY_ID) };
  },
  resolveNames({ users, groups }: IdentityNames): ResolvedIdentityIds {
    return { users: select(users, USERS_BY_NAME), groups: select(groups, GROUPS_BY_NAME) };
  },
});

interface WorkspaceMeta {
  readonly id: string;
  readonly label: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface SqlCost {
  readonly statements: number;
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

export interface ExecResult {
  readonly seq: number;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly cwd: string;
  /** The stored directory no longer existed, so this execution started in the workspace. */
  readonly cwdReset: boolean;
  /** Reported by the shell. Durable Object clocks advance only across I/O, so it can read 0. */
  readonly shellMs: number | null;
  readonly failureCode: string | null;
  /** An exception the shell did not turn into a status, such as an invariant failure. */
  readonly error: string | null;
  readonly sql: SqlCost;
  readonly mutations: number;
  readonly commands: readonly { readonly name: string; readonly exitCode: number }[];
  readonly limits: readonly {
    readonly limit: string;
    readonly used: number;
    readonly max: number;
  }[];
}

export interface SeedFile {
  readonly path: string;
  readonly content: string;
}

export interface WorkspaceInfo {
  readonly meta: WorkspaceMeta;
  readonly cwd: string;
  readonly execCount: number;
  readonly entries: number;
  readonly logicalBytes: number;
  readonly databaseBytes: number;
  readonly sql: SqlCost;
}

export interface ExecLogEntry {
  readonly seq: number;
  readonly at: number;
  readonly script: string;
  readonly cwdBefore: string;
  readonly cwdAfter: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly shellMs: number | null;
  readonly failureCode: string | null;
  readonly error: string | null;
  readonly sql: SqlCost;
  readonly commands: ExecResult["commands"];
  readonly limits: ExecResult["limits"];
}

type Outcome<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly status: 400 | 404 | 410; readonly error: string };

function failure(status: 400 | 404 | 410, error: string): Outcome<never> {
  return { ok: false, status, error };
}

interface Recording {
  failureCode: string | null;
  shellMs: number | null;
  mutations: number;
  commands: { name: string; exitCode: number }[];
  limits: { limit: string; used: number; max: number }[];
}

function truncate(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  return new TextDecoder().decode(bytes.subarray(0, maxBytes));
}

function cost(meter: SqlMeter): SqlCost {
  return { statements: meter.statements, rowsRead: meter.rowsRead, rowsWritten: meter.rowsWritten };
}

/**
 * One agent's machine: a Linux-profile workspace whose shell keeps only the
 * working directory between executions, like an agent harness's Bash tool.
 * Variables, functions and options start fresh each time.
 */
export class EvalWorkspace extends DurableObject<AgentEvalEnv> {
  private readonly meter: SqlMeter;
  private readonly fileSystem: DurableObjectFileSystem;
  private meta: WorkspaceMeta | null = null;
  private cwd = LINUX_WORKSPACE;
  private destroyed = false;
  private recording: Recording | null = null;
  private work: Promise<unknown> = Promise.resolve();
  /** Cumulative cost of executions and seeding since this object started. */
  private readonly totals = { statements: 0, rowsRead: 0, rowsWritten: 0 };

  constructor(ctx: DurableObjectState, env: AgentEvalEnv) {
    super(ctx, env);
    // The meter wraps only what the filesystem sees, so harness bookkeeping in
    // the log table and the KV metadata never counts toward an execution.
    this.meter = meterSqlStorage(ctx.storage);
    this.fileSystem = new DurableObjectFileSystem(this.meter.storage, {
      workspaceId: ctx.id.toString(),
      onEvent: (event) => this.observe(event),
    });
    ctx.blockConcurrencyWhile(async () => {
      await this.fileSystem.initialize();
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS eval_exec_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        script TEXT NOT NULL,
        cwd_before TEXT NOT NULL,
        cwd_after TEXT NOT NULL,
        exit_code INTEGER,
        stdout TEXT NOT NULL,
        stderr TEXT NOT NULL,
        stdout_bytes INTEGER NOT NULL,
        stderr_bytes INTEGER NOT NULL,
        shell_ms INTEGER,
        failure_code TEXT,
        error TEXT,
        statements INTEGER NOT NULL,
        rows_read INTEGER NOT NULL,
        rows_written INTEGER NOT NULL,
        commands TEXT NOT NULL,
        limits TEXT NOT NULL
      )`);
      this.meta = (await ctx.storage.get<WorkspaceMeta>(META_KEY)) ?? null;
      this.cwd = (await ctx.storage.get<string>(CWD_KEY)) ?? LINUX_WORKSPACE;
    });
  }

  /** Idempotent: a retried provision of a live workspace returns what exists. */
  provision(meta: WorkspaceMeta): Promise<WorkspaceMeta> {
    return this.serialize(async () => {
      if (this.destroyed) throw new Error("workspace was destroyed");
      if (this.meta !== null) return this.meta;
      const profile = provisionLinuxFilesystem(this.fileSystem, { user: EVAL_USER });
      for (const entry of profile) {
        if (entry.path === EVAL_HOME || entry.path === LINUX_WORKSPACE) {
          this.fileSystem.setOwnership(entry.path, { uid: EVAL_UID, gid: EVAL_GID });
        }
      }
      for (const path of ["/tmp", "/var/tmp"]) this.fileSystem.setMetadata(path, { mode: 0o1777 });
      await this.ctx.storage.put({ [META_KEY]: meta, [CWD_KEY]: LINUX_WORKSPACE });
      this.meta = meta;
      this.cwd = LINUX_WORKSPACE;
      return meta;
    });
  }

  exec(script: string): Promise<Outcome<ExecResult>> {
    return this.serialize(async () => {
      const unavailable = this.unavailable();
      if (unavailable !== null) return unavailable;
      const cwdBefore = this.cwd;
      const cwdReset = !this.isDirectory(cwdBefore);
      const startCwd = cwdReset ? LINUX_WORKSPACE : cwdBefore;
      const shell = new InteractiveShell({
        fileSystem: this.fileSystem,
        commands: EVAL_COMMANDS,
        ...LINUX_SHELL_OPTIONS,
        cwd: startCwd,
        env: linuxShellEnvironment({ user: EVAL_USER }),
        credentials: EVAL_CREDENTIALS,
        umask: EVAL_UMASK,
        identityResolver: EVAL_IDENTITY_RESOLVER,
        onEvent: (event) => this.observe(event),
      });

      const recording: Recording = {
        failureCode: null,
        shellMs: null,
        mutations: 0,
        commands: [],
        limits: [],
      };
      this.recording = recording;
      this.meter.reset();
      let result: ExecuteTextResult | null = null;
      let error: string | null = null;
      try {
        result = await shell.runText({ script });
      } catch (caught) {
        error =
          caught instanceof VfsError
            ? `${caught.code}: ${caught.message}`
            : caught instanceof Error
              ? caught.message
              : String(caught);
      } finally {
        this.recording = null;
      }
      const sql = cost(this.meter);
      this.accumulate(sql);
      // A unit can end somewhere that no longer exists (`cd x && rm -rf ../x`);
      // the next execution notices and reports the reset.
      const cwd = shell.cwd;
      if (cwd !== cwdBefore) await this.ctx.storage.put(CWD_KEY, cwd);
      this.cwd = cwd;

      const stdout = result?.stdout ?? "";
      const stderr = result?.stderr ?? "";
      const exitCode = result?.exitCode ?? null;
      const encoder = new TextEncoder();
      const row = this.ctx.storage.sql
        .exec<{ seq: number }>(
          `INSERT INTO eval_exec_log (at, script, cwd_before, cwd_after, exit_code, stdout, stderr,
             stdout_bytes, stderr_bytes, shell_ms, failure_code, error, statements, rows_read,
             rows_written, commands, limits)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
          Date.now(),
          script,
          startCwd,
          cwd,
          exitCode,
          truncate(stdout, LOGGED_OUTPUT_BYTES),
          truncate(stderr, LOGGED_OUTPUT_BYTES),
          encoder.encode(stdout).byteLength,
          encoder.encode(stderr).byteLength,
          recording.shellMs,
          recording.failureCode,
          error,
          sql.statements,
          sql.rowsRead,
          sql.rowsWritten,
          JSON.stringify(recording.commands),
          JSON.stringify(recording.limits),
        )
        .one();
      return {
        ok: true,
        value: {
          seq: row.seq,
          exitCode,
          stdout,
          stderr,
          cwd,
          cwdReset,
          shellMs: recording.shellMs,
          failureCode: recording.failureCode,
          error,
          sql,
          mutations: recording.mutations,
          commands: recording.commands,
          limits: recording.limits,
        },
      };
    });
  }

  /**
   * Writes fixture files as the agent's account, creating parents, in one
   * atomic batch. Relative paths are relative to the workspace directory.
   */
  seed(files: readonly SeedFile[]): Promise<Outcome<{ written: number; sql: SqlCost }>> {
    return this.serialize(async () => {
      const unavailable = this.unavailable();
      if (unavailable !== null) return unavailable;
      const view: VirtualFileSystem = this.fileSystem.forCredentials(EVAL_CREDENTIALS, {
        umask: EVAL_UMASK,
      });
      this.meter.reset();
      try {
        await view.writeFiles(
          files.map((file) => ({
            path: file.path.startsWith("/") ? file.path : `${LINUX_WORKSPACE}/${file.path}`,
            body: file.content,
          })),
          { createParents: true },
        );
      } catch (caught) {
        if (caught instanceof VfsError) return failure(400, `${caught.code}: ${caught.message}`);
        throw caught;
      } finally {
        this.accumulate(cost(this.meter));
      }
      return { ok: true, value: { written: files.length, sql: cost(this.meter) } };
    });
  }

  info(): Outcome<WorkspaceInfo> {
    if (this.destroyed || this.meta === null) return failure(404, "instance not found");
    const summary = this.fileSystem.subtreeSummary("/");
    const execCount = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM eval_exec_log")
      .one().count;
    return {
      ok: true,
      value: {
        meta: this.meta,
        cwd: this.cwd,
        execCount,
        entries: summary.entries,
        logicalBytes: summary.logicalFileBytes,
        databaseBytes: this.ctx.storage.sql.databaseSize,
        sql: { ...this.totals },
      },
    };
  }

  log(after: number, limit: number): Outcome<ExecLogEntry[]> {
    if (this.destroyed || this.meta === null) return failure(404, "instance not found");
    const rows = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>(
        "SELECT * FROM eval_exec_log WHERE seq > ? ORDER BY seq LIMIT ?",
        after,
        Math.min(Math.max(limit, 1), MAX_LOG_PAGE),
      )
      .toArray();
    return {
      ok: true,
      value: rows.map((row) => ({
        seq: Number(row["seq"]),
        at: Number(row["at"]),
        script: String(row["script"]),
        cwdBefore: String(row["cwd_before"]),
        cwdAfter: String(row["cwd_after"]),
        exitCode: row["exit_code"] === null ? null : Number(row["exit_code"]),
        stdout: String(row["stdout"]),
        stderr: String(row["stderr"]),
        stdoutBytes: Number(row["stdout_bytes"]),
        stderrBytes: Number(row["stderr_bytes"]),
        shellMs: row["shell_ms"] === null ? null : Number(row["shell_ms"]),
        failureCode: row["failure_code"] === null ? null : String(row["failure_code"]),
        error: row["error"] === null ? null : String(row["error"]),
        sql: {
          statements: Number(row["statements"]),
          rowsRead: Number(row["rows_read"]),
          rowsWritten: Number(row["rows_written"]),
        },
        commands: JSON.parse(String(row["commands"])) as ExecLogEntry["commands"],
        limits: JSON.parse(String(row["limits"])) as ExecLogEntry["limits"],
      })),
    };
  }

  /**
   * Erases everything this object stored. Instance IDs are never reused, so
   * the in-memory flag only has to outlive this object's residency.
   */
  destroy(): Promise<void> {
    return this.serialize(async () => {
      this.destroyed = true;
      this.meta = null;
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
    });
  }

  override async alarm(): Promise<void> {
    if (this.destroyed) return;
    await this.fileSystem.drainGarbage();
  }

  private unavailable(): Outcome<never> | null {
    if (this.destroyed || this.meta === null) return failure(404, "instance not found");
    if (this.meta.expiresAt <= Date.now()) return failure(410, "instance expired");
    return null;
  }

  private isDirectory(path: string): boolean {
    try {
      return this.fileSystem.stat(path).kind === "directory";
    } catch (caught) {
      if (caught instanceof VfsError) return false;
      throw caught;
    }
  }

  private accumulate(sql: SqlCost): void {
    this.totals.statements += sql.statements;
    this.totals.rowsRead += sql.rowsRead;
    this.totals.rowsWritten += sql.rowsWritten;
  }

  private observe(event: VfsEvent | ShellEvent): void {
    const recording = this.recording;
    if (recording === null) return;
    switch (event.type) {
      case "shell.command":
        if (recording.commands.length < MAX_RECORDED_COMMANDS) {
          recording.commands.push({ name: event.name, exitCode: event.exitCode });
        }
        break;
      case "shell.limit":
        recording.limits.push({ limit: event.limit, used: event.used, max: event.max });
        break;
      case "vfs.quota":
        recording.limits.push({ limit: `vfs.${event.limit}`, used: event.used, max: event.max });
        break;
      case "shell.execution":
        recording.shellMs = event.durationMs;
        recording.failureCode = event.failureCode ?? null;
        break;
      case "vfs.mutation":
        recording.mutations += 1;
        break;
      default:
        break;
    }
  }

  /** One operation at a time, so an execution's cwd and meter belong to it alone. */
  private serialize<Value>(operation: () => Promise<Value>): Promise<Value> {
    const run = this.work.then(operation, operation);
    this.work = run.catch(() => undefined);
    return run;
  }
}

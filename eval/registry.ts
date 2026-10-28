import { DurableObject } from "cloudflare:workers";
import type { SeedFile } from "./workspace.js";

type InstanceState = "creating" | "ready" | "deleting";

export interface Instance {
  readonly id: string;
  readonly label: string;
  readonly state: InstanceState;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly updatedAt: number;
}

type CreateOutcome =
  | { readonly ok: true; readonly instance: Instance }
  | { readonly ok: false; readonly status: 429 | 500; readonly error: string };

/** How long `creating` or `deleting` may last before the sweep finishes it. */
const STALE_TRANSITION_MS = 5 * 60 * 1000;
const RETRY_SWEEP_MS = 60 * 1000;
const DEFAULT_MAX_INSTANCES = 20;

function toInstance(row: Record<string, SqlStorageValue>): Instance {
  return {
    id: String(row["id"]),
    label: String(row["label"]),
    state: String(row["state"]) as InstanceState,
    createdAt: Number(row["created_at"]),
    expiresAt: Number(row["expires_at"]),
    updatedAt: Number(row["updated_at"]),
  };
}

/**
 * The list of evaluation workspaces and their lifecycle.
 *
 * Kept off the execution path: an exec goes straight to its workspace, which
 * holds its own metadata. Registry rows and workspace storage cannot share a
 * transaction, so every row carries its state and the alarm finishes any
 * creation or deletion that a crash left halfway, as well as expiry.
 */
export class EvalRegistry extends DurableObject<AgentEvalEnv> {
  constructor(ctx: DurableObjectState, env: AgentEvalEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS eval_instances (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  }

  async create(label: string, ttlMs: number, files: readonly SeedFile[]): Promise<CreateOutcome> {
    const now = Date.now();
    const id = crypto.randomUUID();
    const reserved = this.ctx.storage.transactionSync(() => {
      const active = this.ctx.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM eval_instances")
        .one().count;
      if (active >= this.maxInstances()) return false;
      this.ctx.storage.sql.exec(
        "INSERT INTO eval_instances VALUES (?, ?, 'creating', ?, ?, ?)",
        id,
        label,
        now,
        now + ttlMs,
        now,
      );
      return true;
    });
    if (!reserved) {
      return { ok: false, status: 429, error: "instance limit reached; delete one first" };
    }
    await this.schedule(now + STALE_TRANSITION_MS);

    const workspace = this.env.EVAL_WORKSPACES.getByName(id);
    try {
      await workspace.provision({ id, label, createdAt: now, expiresAt: now + ttlMs });
      if (files.length > 0) {
        const seeded = await workspace.seed(files);
        if (!seeded.ok) throw new Error(seeded.error);
      }
    } catch (caught) {
      await this.destroy(id).catch(() => undefined);
      return {
        ok: false,
        status: 500,
        error: `provisioning failed: ${caught instanceof Error ? caught.message : String(caught)}`,
      };
    }
    this.ctx.storage.sql.exec(
      "UPDATE eval_instances SET state = 'ready', updated_at = ? WHERE id = ? AND state = 'creating'",
      Date.now(),
      id,
    );
    await this.reschedule();
    const instance = this.get(id);
    if (instance === null) return { ok: false, status: 500, error: "instance vanished" };
    return { ok: true, instance };
  }

  list(): Instance[] {
    return this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>("SELECT * FROM eval_instances ORDER BY created_at, id")
      .toArray()
      .map(toInstance);
  }

  get(id: string): Instance | null {
    const row = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>("SELECT * FROM eval_instances WHERE id = ?", id)
      .toArray()[0];
    return row === undefined ? null : toInstance(row);
  }

  /** Idempotent. Returns false when no such instance is registered. */
  async destroy(id: string): Promise<boolean> {
    const marked = this.ctx.storage.sql.exec(
      "UPDATE eval_instances SET state = 'deleting', updated_at = ? WHERE id = ?",
      Date.now(),
      id,
    ).rowsWritten;
    if (marked === 0) return false;
    // If the workspace call fails the row stays `deleting` and the sweep retries.
    await this.schedule(Date.now() + RETRY_SWEEP_MS);
    await this.env.EVAL_WORKSPACES.getByName(id).destroy();
    this.ctx.storage.sql.exec("DELETE FROM eval_instances WHERE id = ?", id);
    await this.reschedule();
    return true;
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const due = this.ctx.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM eval_instances
         WHERE expires_at <= ?
            OR (state = 'deleting')
            OR (state = 'creating' AND updated_at <= ?)`,
        now,
        now - STALE_TRANSITION_MS,
      )
      .toArray();
    for (const { id } of due) {
      try {
        await this.destroy(id);
      } catch {
        // Left as `deleting`; the rescheduled alarm retries it.
      }
    }
    await this.reschedule();
  }

  private maxInstances(): number {
    const configured = Number(this.env.AGENT_EVAL_MAX_INSTANCES);
    return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_INSTANCES;
  }

  /** Points the alarm at the next expiry or pending transition, or clears it. */
  private async reschedule(): Promise<void> {
    const next = this.ctx.storage.sql
      .exec<{ next: number | null }>(
        `SELECT MIN(CASE state
                      WHEN 'ready' THEN expires_at
                      WHEN 'creating' THEN MIN(expires_at, updated_at + ?)
                      ELSE updated_at + ? END) AS next
         FROM eval_instances`,
        STALE_TRANSITION_MS,
        RETRY_SWEEP_MS,
      )
      .one().next;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1_000));
  }

  /** Brings the alarm forward to `at` without postponing an earlier one. */
  private async schedule(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }
}
